"""
HAMELEONWEB License API
FastAPI server for license management and authentication
"""

import os
import uuid
import asyncio
import hashlib
import secrets
import requests as requests_sync
from datetime import datetime, timedelta
from typing import Optional, List
from contextlib import asynccontextmanager
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, HTTPException, Depends, Header, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy import Column, Integer, String, DateTime, Boolean, ForeignKey, Text, select, func
import jwt
import httpx

# Database setup
DB_PATH = os.getenv("DB_PATH", "./data/hameleonweb.db")
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite+aiosqlite:///{DB_PATH}")
os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
engine = create_async_engine(DATABASE_URL, echo=False)
async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
Base = declarative_base()

# JWT Config
JWT_SECRET = os.getenv("JWT_SECRET", "change_me")
JWT_EXPIRE_HOURS = int(os.getenv("JWT_EXPIRE_HOURS", "24"))

# NOWPayments
NOWPAYMENTS_API_KEY = os.getenv("NOWPAYMENTS_API_KEY", "")
NOWPAYMENTS_IPN_SECRET = os.getenv("NOWPAYMENTS_IPN_SECRET", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")

security = HTTPBearer()

# ============ DATABASE MODELS ============

class Client(Base):
    __tablename__ = "clients"
    
    id = Column(Integer, primary_key=True, index=True)
    telegram_id = Column(Integer, unique=True, nullable=False, index=True)
    username = Column(String(100))
    first_name = Column(String(100))
    last_name = Column(String(100))
    phone = Column(String(50))
    balance_usd = Column(Integer, default=0)  # stored in cents, e.g. 1000 = $10.00
    created_at = Column(DateTime, default=datetime.utcnow)

class BalanceTransaction(Base):
    __tablename__ = "balance_transactions"

    id = Column(Integer, primary_key=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    amount_cents = Column(Integer, nullable=False)  # positive = credit, negative = debit
    reason = Column(String(200))          # e.g. "topup", "license_renewal", "manual"
    invoice_id = Column(String(200))
    created_at = Column(DateTime, default=datetime.utcnow)
    
class Package(Base):
    __tablename__ = "packages"
    
    id = Column(Integer, primary_key=True)
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(Text)
    price_usd = Column(Integer, nullable=False)  # in cents (2900 = $29.00)
    duration_days = Column(Integer, nullable=False)
    max_devices = Column(Integer, default=1)
    max_accounts = Column(Integer, default=1)
    features = Column(String(500))  # JSON array
    is_active = Column(Boolean, default=True)
    sort_order = Column(Integer, default=0)
    
class License(Base):
    __tablename__ = "licenses"
    
    id = Column(Integer, primary_key=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    license_key = Column(String(100), unique=True, nullable=False)
    fingerprint = Column(String(200))
    activated_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime)
    trial_started_at = Column(DateTime)
    trial_used = Column(Boolean, default=False)
    status = Column(String(50), default="active")
    package_id = Column(Integer, ForeignKey("packages.id"))
    
class AuthCode(Base):
    __tablename__ = "auth_codes"
    
    id = Column(Integer, primary_key=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    code_hash = Column(String(200), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used = Column(Boolean, default=False)
    attempts = Column(Integer, default=0)
    device_id = Column(String(200))
    ip_address = Column(String(50))
    created_at = Column(DateTime, default=datetime.utcnow)
    
class Purchase(Base):
    __tablename__ = "purchases"
    
    id = Column(Integer, primary_key=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    package_id = Column(Integer, ForeignKey("packages.id"), nullable=False)
    quantity = Column(Integer, default=1)
    total_price_usd = Column(Integer, nullable=False)  # cents
    invoice_id = Column(String(200))
    payment_status = Column(String(50), default="pending")  # pending, waiting, confirming, finished, expired
    license_id = Column(Integer, ForeignKey("licenses.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class Device(Base):
    __tablename__ = "devices"
    
    id = Column(Integer, primary_key=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    device_id = Column(String(200), unique=True, nullable=False)
    device_name = Column(String(200))
    first_login = Column(DateTime, default=datetime.utcnow)
    last_seen = Column(DateTime, default=datetime.utcnow)
    is_active = Column(Boolean, default=True)

# ============ PYDANTIC SCHEMAS ============

class AuthRequest(BaseModel):
    telegram_id: Optional[int] = None
    telegram_login: Optional[str] = None
    device_id: Optional[str] = None
    device_name: Optional[str] = None

class AuthVerify(BaseModel):
    telegram_id: Optional[int] = None
    telegram_login: Optional[str] = None
    code: str
    device_id: Optional[str] = None
    device_name: Optional[str] = None

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int
    token_type: str = "bearer"

class LicenseResponse(BaseModel):
    license_key: str
    expires_at: Optional[datetime]
    status: str
    max_devices: int
    max_accounts: int

class PackageResponse(BaseModel):
    id: int
    code: str
    name: str
    description: Optional[str]
    price_usd: int
    duration_days: int
    max_devices: int
    max_accounts: int

class CreatePurchaseRequest(BaseModel):
    package_id: int
    quantity: int = Field(default=1, ge=1, le=100)

class CreateInvoiceResponse(BaseModel):
    invoice_id: str
    pay_address: str
    pay_amount: str
    pay_currency: str
    qr_url: str

class ClientUpsertRequest(BaseModel):
    telegram_id: int
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    
# ============ LIFESPAN ============

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database and seed default packages"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    
    # Seed default packages
    async with async_session() as session:
        result = await session.execute(select(Package).limit(1))
        if not result.scalar_one_or_none():
            packages = [
                Package(code="monthly_1", name="Месячная лицензия (1 аккаунт)", price_usd=2900, duration_days=30, max_devices=1, max_accounts=1),
                Package(code="monthly_5", name="Месячная лицензия (5 аккаунтов)", price_usd=7900, duration_days=30, max_devices=2, max_accounts=5),
                Package(code="yearly_1", name="Годовая лицензия (1 аккаунт)", price_usd=19900, duration_days=365, max_devices=1, max_accounts=1),
                Package(code="yearly_unlimited", name="Годовая безлимитная", price_usd=49900, duration_days=365, max_devices=5, max_accounts=999),
            ]
            session.add_all(packages)
            await session.commit()
            print("✅ Default packages seeded")
    
    # Start auto-renewal background task
    renew_task = asyncio.create_task(auto_renew_licenses())

    yield

    renew_task.cancel()
    await engine.dispose()

app = FastAPI(
    title="HAMELEONWEB License API",
    description="API for license management and authentication",
    version="1.0.0",
    lifespan=lifespan
)

# CORS for Electron app
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============ HELPERS ============

async def get_db():
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()

def generate_license_key():
    """Generate HW-XXXX-XXXX-XXXX format key"""
    key = 'HW-' + secrets.token_hex(6).upper()[:12]
    return key[:4] + '-' + key[4:8] + '-' + key[8:12] + '-' + key[12:16]

def generate_auth_code():
    """Generate 6-digit code"""
    return str(secrets.randbelow(900000) + 100000)

def hash_code(code: str) -> str:
    """Hash auth code with secret"""
    return hashlib.sha256(f"{code}{JWT_SECRET}".encode()).hexdigest()

def create_jwt_token(client_id: int, device_id: Optional[str] = None) -> dict:
    """Create JWT access and refresh tokens"""
    now = datetime.utcnow()
    access_payload = {
        "client_id": client_id,
        "device_id": device_id,
        "type": "access",
        "iat": now,
        "exp": now + timedelta(hours=JWT_EXPIRE_HOURS)
    }
    refresh_payload = {
        "client_id": client_id,
        "type": "refresh",
        "iat": now,
        "exp": now + timedelta(days=30)
    }
    
    return {
        "access_token": jwt.encode(access_payload, JWT_SECRET, algorithm="HS256"),
        "refresh_token": jwt.encode(refresh_payload, JWT_SECRET, algorithm="HS256"),
        "expires_in": JWT_EXPIRE_HOURS * 3600
    }

async def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """Verify JWT token"""
    token = credentials.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        if payload.get("type") != "access":
            raise HTTPException(401, "Invalid token type")
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except Exception:
        raise HTTPException(401, "Invalid token")

async def send_telegram_message(chat_id: int, text: str):
    if not TELEGRAM_BOT_TOKEN:
        return

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    async with httpx.AsyncClient() as client:
        response = await client.post(url, json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
        }, timeout=20.0)
        response.raise_for_status()

def normalize_telegram_login(telegram_login: Optional[str]) -> Optional[str]:
    if telegram_login is None:
        return None
    value = str(telegram_login).strip()
    if not value:
        return None
    if value.startswith("@"):
        value = value[1:]
    return value.lower()

async def find_client_by_login(db: AsyncSession, telegram_id: Optional[int] = None, telegram_login: Optional[str] = None):
    if telegram_id is not None:
        result = await db.execute(select(Client).where(Client.telegram_id == telegram_id))
        client = result.scalar_one_or_none()
        if client:
            return client

    login = normalize_telegram_login(telegram_login)
    if login is None:
        return None

    if login.isdigit():
        result = await db.execute(select(Client).where(Client.telegram_id == int(login)))
        client = result.scalar_one_or_none()
        if client:
            return client

    result = await db.execute(select(Client).where(func.lower(Client.username) == login))
    return result.scalar_one_or_none()

# ============ API ENDPOINTS ============

@app.get("/")
async def root():
    return {"status": "ok", "service": "HAMELEONWEB License API"}

@app.get("/health")
async def health():
    return {"status": "healthy"}

@app.post("/api/clients/upsert")
async def upsert_client(data: ClientUpsertRequest, db: AsyncSession = Depends(get_db)):
    """Create or update a client record from the Telegram bot /start flow."""
    result = await db.execute(select(Client).where(Client.telegram_id == data.telegram_id))
    client = result.scalar_one_or_none()

    if client:
        client.username = data.username
        client.first_name = data.first_name
        client.last_name = data.last_name
        if data.phone is not None:
            client.phone = data.phone
    else:
        client = Client(
            telegram_id=data.telegram_id,
            username=data.username,
            first_name=data.first_name,
            last_name=data.last_name,
            phone=data.phone,
        )
        db.add(client)

    await db.commit()
    await db.refresh(client)

    return {
        "success": True,
        "client_id": client.id,
        "telegram_id": client.telegram_id,
        "username": client.username,
    }

# ============ AUTH ENDPOINTS ============

@app.post("/api/auth/request-code", response_model=dict)
async def request_code(data: AuthRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """
    Request authentication code.
    Sends 6-digit code to user's Telegram via bot.
    """
    # Find or create client
    client = await find_client_by_login(db, data.telegram_id, data.telegram_login)
    
    if not client:
        raise HTTPException(404, "User not found. Please start the bot first with /start command or use the Telegram username linked in the bot")
    
    # Generate code
    code = generate_auth_code()
    code_hash = hash_code(code)
    expires_at = datetime.utcnow() + timedelta(minutes=5)
    
    # Save to database
    auth_code = AuthCode(
        client_id=client.id,
        code_hash=code_hash,
        expires_at=expires_at,
        device_id=data.device_id,
        ip_address=request.client.host
    )
    db.add(auth_code)
    await db.commit()

    telegram_message = (
        "🔐 <b>Код для входа в HAMELEONWEB</b>\n\n"
        f"<code>{code}</code>\n\n"
        "Код действителен 5 минут.\n"
        "Введите его в приложении для завершения входа."
    )

    try:
        await send_telegram_message(client.telegram_id, telegram_message)
    except Exception as exc:
        raise HTTPException(500, f"Failed to send Telegram code: {str(exc)}")
    
    return {
        "success": True,
        "message": "Code sent to Telegram",
        "expires_in": 300  # 5 minutes in seconds
    }

@app.post("/api/auth/verify-code", response_model=TokenResponse)
async def verify_code(data: AuthVerify, request: Request, db: AsyncSession = Depends(get_db)):
    """
    Verify 6-digit code and return JWT tokens.
    Also creates/activates license if needed.
    """
    # Find client
    client = await find_client_by_login(db, data.telegram_id, data.telegram_login)
    
    if not client:
        raise HTTPException(404, "User not found")
    
    # Find valid auth code
    code_hash = hash_code(data.code)
    result = await db.execute(
        select(AuthCode).where(
            AuthCode.client_id == client.id,
            AuthCode.code_hash == code_hash,
            AuthCode.used == False,
            AuthCode.expires_at > datetime.utcnow()
        )
    )
    auth_code = result.scalar_one_or_none()
    
    if not auth_code:
        # Increment attempts on wrong code
        result = await db.execute(
            select(AuthCode).where(
                AuthCode.client_id == client.id,
                AuthCode.used == False,
                AuthCode.expires_at > datetime.utcnow()
            )
        )
        recent_code = result.scalar_one_or_none()
        if recent_code:
            recent_code.attempts += 1
            await db.commit()
            if recent_code.attempts >= 3:
                raise HTTPException(403, "Too many attempts. Please request new code.")
        
        raise HTTPException(401, "Invalid or expired code")
    
    # Mark code as used
    auth_code.used = True
    
    # Register/update device
    if data.device_id:
        result = await db.execute(
            select(Device).where(Device.device_id == data.device_id)
        )
        device = result.scalar_one_or_none()
        
        if not device:
            device = Device(
                client_id=client.id,
                device_id=data.device_id,
                device_name=data.device_name or "Unknown Device"
            )
            db.add(device)
        else:
            device.last_seen = datetime.utcnow()
    
    await db.commit()
    
    # Generate tokens
    tokens = create_jwt_token(client.id, data.device_id)
    
    return TokenResponse(**tokens)

@app.post("/api/auth/refresh", response_model=TokenResponse)
async def refresh_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Refresh access token using refresh token"""
    token = credentials.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        if payload.get("type") != "refresh":
            raise HTTPException(401, "Invalid token type")
        
        client_id = payload.get("client_id")
        tokens = create_jwt_token(client_id)
        
        return TokenResponse(**tokens)
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Refresh token expired")
    except Exception:
        raise HTTPException(401, "Invalid token")

# ============ LICENSE ENDPOINTS ============

@app.get("/api/license/my", response_model=List[LicenseResponse])
async def get_my_licenses(payload: dict = Depends(verify_token), db: AsyncSession = Depends(get_db)):
    """Get all licenses for current user"""
    client_id = payload.get("client_id")
    
    result = await db.execute(
        select(License, Package).join(Package, License.package_id == Package.id, isouter=True)
        .where(License.client_id == client_id)
        .order_by(License.activated_at.desc())
    )
    
    licenses = []
    for row in result.all():
        license_obj = row.License
        package = row.Package
        
        licenses.append(LicenseResponse(
            license_key=license_obj.license_key,
            expires_at=license_obj.expires_at,
            status=license_obj.status,
            max_devices=package.max_devices if package else 1,
            max_accounts=package.max_accounts if package else 1
        ))
    
    return licenses

@app.get("/api/license/verify")
async def verify_license(
    license_key: str,
    fingerprint: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    """Public endpoint to verify license validity"""
    result = await db.execute(
        select(License, Package).join(Package, License.package_id == Package.id, isouter=True)
        .where(License.license_key == license_key)
    )
    row = result.first()
    
    if not row:
        raise HTTPException(404, "License not found")
    
    license_obj = row.License
    package = row.Package
    
    # Check expiration
    if license_obj.expires_at and license_obj.expires_at < datetime.utcnow():
        return {
            "valid": False,
            "reason": "expired",
            "expires_at": license_obj.expires_at
        }
    
    # Check status
    if license_obj.status not in ["active", "trial"]:
        return {
            "valid": False,
            "reason": "inactive",
            "status": license_obj.status
        }
    
    return {
        "valid": True,
        "license_key": license_obj.license_key,
        "status": license_obj.status,
        "expires_at": license_obj.expires_at,
        "max_devices": package.max_devices if package else 1,
        "max_accounts": package.max_accounts if package else 1
    }

# ============ PACKAGES ENDPOINTS ============

@app.get("/api/packages", response_model=List[PackageResponse])
async def get_packages(db: AsyncSession = Depends(get_db)):
    """Get all active packages"""
    result = await db.execute(
        select(Package).where(Package.is_active == True).order_by(Package.sort_order)
    )
    packages = result.scalars().all()
    
    return [
        PackageResponse(
            id=p.id,
            code=p.code,
            name=p.name,
            description=p.description,
            price_usd=p.price_usd,
            duration_days=p.duration_days,
            max_devices=p.max_devices,
            max_accounts=p.max_accounts
        ) for p in packages
    ]

# ============ PAYMENT ENDPOINTS ============

@app.post("/api/payment/create-invoice", response_model=CreateInvoiceResponse)
async def create_invoice(
    data: CreatePurchaseRequest,
    payload: dict = Depends(verify_token),
    db: AsyncSession = Depends(get_db)
):
    """Create NOWPayments invoice for package purchase"""
    client_id = payload.get("client_id")
    
    # Get package
    result = await db.execute(select(Package).where(Package.id == data.package_id))
    package = result.scalar_one_or_none()
    
    if not package:
        raise HTTPException(404, "Package not found")
    
    # Calculate total
    total_price = package.price_usd * data.quantity
    
    # Create purchase record
    purchase = Purchase(
        client_id=client_id,
        package_id=data.package_id,
        quantity=data.quantity,
        total_price_usd=total_price
    )
    db.add(purchase)
    await db.flush()
    
    # Create NOWPayments invoice
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.nowpayments.io/v1/invoice",
                headers={
                    "x-api-key": NOWPAYMENTS_API_KEY,
                    "Content-Type": "application/json"
                },
                json={
                    "price_amount": total_price / 100,  # cents to dollars
                    "price_currency": "usd",
                    "pay_currency": "usdttrc20",
                    "order_id": str(purchase.id),
                    "order_description": f"HameleonWeb: {package.name} x{data.quantity}"
                },
                timeout=30.0
            )
            
            if response.status_code != 200:
                raise HTTPException(500, f"Payment provider error: {response.text}")
            
            invoice_data = response.json()
            
            # Update purchase with invoice_id
            purchase.invoice_id = invoice_data.get("id")
            purchase.payment_status = "waiting"
            await db.commit()
            
            # Generate QR code URL
            pay_address = invoice_data.get("pay_address", "")
            qr_url = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={pay_address}"
            
            return CreateInvoiceResponse(
                invoice_id=invoice_data.get("id"),
                pay_address=pay_address,
                pay_amount=invoice_data.get("pay_amount", ""),
                pay_currency=invoice_data.get("pay_currency", "usdttrc20"),
                qr_url=qr_url
            )
            
    except httpx.RequestError as e:
        await db.rollback()
        raise HTTPException(500, f"Payment service unavailable: {str(e)}")

@app.post("/api/payment/webhook/nowpayments")
async def nowpayments_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """Webhook handler for NOWPayments status updates"""
    # Verify IPN signature
    body = await request.body()
    signature = request.headers.get("x-nowpayments-sig", "")
    
    expected_sig = hashlib.hmac.new(
        NOWPAYMENTS_IPN_SECRET.encode(),
        body,
        hashlib.sha512
    ).hexdigest()
    
    if signature != expected_sig:
        raise HTTPException(401, "Invalid signature")
    
    data = await request.json()
    invoice_id = data.get("id")
    payment_status = data.get("payment_status", "")
    
    # Find purchase
    result = await db.execute(
        select(Purchase).where(Purchase.invoice_id == invoice_id)
    )
    purchase = result.scalar_one_or_none()
    
    if not purchase:
        raise HTTPException(404, "Purchase not found")
    
    # Update status
    purchase.payment_status = payment_status
    purchase.updated_at = datetime.utcnow()
    
    # If paid, create license
    if payment_status in ["finished", "confirmed"] and not purchase.license_id:
        # Get package details
        result = await db.execute(
            select(Package).where(Package.id == purchase.package_id)
        )
        package = result.scalar_one()
        
        # Create license
        expires_at = datetime.utcnow() + timedelta(days=package.duration_days * purchase.quantity)
        
        license = License(
            client_id=purchase.client_id,
            license_key=generate_license_key(),
            expires_at=expires_at,
            status="active",
            package_id=purchase.package_id
        )
        db.add(license)
        await db.flush()
        
        purchase.license_id = license.id
    
    await db.commit()
    
    return {"status": "ok"}

@app.get("/api/payment/status/{invoice_id}")
async def check_payment_status(
    invoice_id: str,
    payload: dict = Depends(verify_token),
    db: AsyncSession = Depends(get_db)
):
    """Check payment status"""
    result = await db.execute(
        select(Purchase).where(Purchase.invoice_id == invoice_id)
    )
    purchase = result.scalar_one_or_none()
    
    if not purchase:
        raise HTTPException(404, "Purchase not found")
    
    # Verify ownership
    if purchase.client_id != payload.get("client_id"):
        raise HTTPException(403, "Not your purchase")
    
    return {
        "invoice_id": invoice_id,
        "status": purchase.payment_status,
        "license_id": purchase.license_id,
        "created_at": purchase.created_at
    }

# ============ TRIAL ENDPOINTS ============

@app.post("/api/trial/start")
async def start_trial(payload: dict = Depends(verify_token), db: AsyncSession = Depends(get_db)):
    """Start 7-day trial"""
    client_id = payload.get("client_id")
    device_id = payload.get("device_id")
    
    # Check if trial already used for this device
    if device_id:
        result = await db.execute(
            select(License).where(
                License.fingerprint == device_id,
                License.trial_used == True
            )
        )
        if result.scalar_one_or_none():
            raise HTTPException(400, "Trial already used on this device")
    
    # Check if user has active licenses
    result = await db.execute(
        select(License).where(
            License.client_id == client_id,
            License.status.in_(["active", "trial"]),
            License.expires_at > datetime.utcnow()
        )
    )
    if result.first():
        raise HTTPException(400, "You already have an active license")
    
    # Create trial license
    trial_days = int(os.getenv("TRIAL_DAYS", "7"))
    license = License(
        client_id=client_id,
        license_key=generate_license_key(),
        fingerprint=device_id,
        trial_started_at=datetime.utcnow(),
        trial_used=True,
        expires_at=datetime.utcnow() + timedelta(days=trial_days),
        status="trial"
    )
    db.add(license)
    await db.commit()
    
    return {
        "success": True,
        "license_key": license.license_key,
        "expires_at": license.expires_at,
        "trial_days": trial_days
    }

@app.get("/api/device/trial-status")
async def device_trial_status(payload: dict = Depends(verify_token), db: AsyncSession = Depends(get_db)):
    """Check if the current device has already used a trial license"""
    device_id = payload.get("device_id")
    if not device_id:
        return {"trial_used": False, "device_id": None}

    result = await db.execute(
        select(License).where(
            License.fingerprint == device_id,
            License.trial_used == True
        )
    )
    used = result.scalar_one_or_none()
    return {
        "trial_used": used is not None,
        "device_id": device_id,
        "expired_at": used.expires_at.isoformat() if used and used.expires_at else None
    }

# ============ BALANCE ENDPOINTS ============

@app.get("/api/balance/me")
async def get_my_balance(payload: dict = Depends(verify_token), db: AsyncSession = Depends(get_db)):
    """Get current user balance and transaction history"""
    client_id = payload.get("client_id")
    result = await db.execute(select(Client).where(Client.id == client_id))
    client = result.scalar_one_or_none()
    if not client:
        raise HTTPException(404, "Client not found")

    txs = await db.execute(
        select(BalanceTransaction)
        .where(BalanceTransaction.client_id == client_id)
        .order_by(BalanceTransaction.created_at.desc())
        .limit(20)
    )
    transactions = txs.scalars().all()

    return {
        "balance_usd": (client.balance_usd or 0) / 100,
        "balance_cents": client.balance_usd or 0,
        "transactions": [
            {
                "id": t.id,
                "amount_usd": t.amount_cents / 100,
                "reason": t.reason,
                "invoice_id": t.invoice_id,
                "created_at": t.created_at.isoformat() if t.created_at else None,
            }
            for t in transactions
        ]
    }

@app.post("/api/balance/topup")
async def topup_balance(
    request: Request,
    payload: dict = Depends(verify_token),
    db: AsyncSession = Depends(get_db)
):
    """Create a NOWPayments payment to top up balance"""
    client_id = payload.get("client_id")
    body = await request.json()
    amount_usd = float(body.get("amount_usd", 0))

    if amount_usd < 1:
        raise HTTPException(400, "Minimum top-up is $1")

    headers = {"x-api-key": NOWPAYMENTS_API_KEY, "Content-Type": "application/json"}
    data = {
        "price_amount": amount_usd,
        "price_currency": "usd",
        "pay_currency": "usdttrc20",
        "order_id": f"topup_{client_id}_{int(datetime.now().timestamp())}",
        "order_description": f"HAMELEONWEB balance top-up for client {client_id}",
    }
    try:
        resp = requests_sync.post("https://api.nowpayments.io/v1/payment", json=data, headers=headers, timeout=20)
        if resp.status_code not in (200, 201):
            raise HTTPException(502, f"NOWPayments error: {resp.text}")
        invoice = resp.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Payment service unavailable: {e}")

    return {
        "payment_id": invoice.get("payment_id"),
        "pay_address": invoice.get("pay_address"),
        "pay_amount": invoice.get("pay_amount"),
        "pay_currency": str(invoice.get("pay_currency", "USDTTRC20")).upper(),
        "amount_usd": amount_usd,
    }

@app.post("/api/balance/credit")
async def credit_balance(request: Request, db: AsyncSession = Depends(get_db)):
    """Credit balance after confirmed NOWPayments payment (called by bot/webhook)"""
    body = await request.json()
    secret = body.get("secret", "")
    if secret != JWT_SECRET:
        raise HTTPException(403, "Forbidden")

    client_id = int(body.get("client_id", 0))
    amount_cents = int(body.get("amount_cents", 0))
    invoice_id = body.get("invoice_id", "")
    reason = body.get("reason", "topup")

    if amount_cents <= 0:
        raise HTTPException(400, "Invalid amount")

    result = await db.execute(select(Client).where(Client.id == client_id))
    client = result.scalar_one_or_none()
    if not client:
        raise HTTPException(404, "Client not found")

    client.balance_usd = (client.balance_usd or 0) + amount_cents
    tx = BalanceTransaction(
        client_id=client_id,
        amount_cents=amount_cents,
        reason=reason,
        invoice_id=invoice_id,
    )
    db.add(tx)
    await db.commit()

    return {"balance_usd": client.balance_usd / 100, "credited_cents": amount_cents}

# ============ AUTO-RENEWAL BACKGROUND TASK ============

async def auto_renew_licenses():
    """
    Runs hourly. For each license expiring within 24h:
    - Deduct price from client balance
    - Extend license by 30 days
    - Record transaction
    - Notify via Telegram if balance insufficient
    """
    while True:
        try:
            await asyncio.sleep(3600)  # run every hour
            now = datetime.utcnow()
            window_end = now + timedelta(hours=24)

            async with async_session() as db:
                result = await db.execute(
                    select(License, Client)
                    .join(Client, License.client_id == Client.id)
                    .where(
                        License.status.in_(["active", "trial"]),
                        License.expires_at > now,
                        License.expires_at <= window_end,
                    )
                )
                rows = result.all()

                for license, client in rows:
                    # Determine renewal price: trial → use solo package price
                    renewal_cents = 1000  # default $10 — override with package price if set
                    if license.package_id:
                        pkg_r = await db.execute(select(Package).where(Package.id == license.package_id))
                        pkg = pkg_r.scalar_one_or_none()
                        if pkg:
                            renewal_cents = pkg.price_usd

                    balance = client.balance_usd or 0

                    if balance >= renewal_cents:
                        # Deduct and extend
                        client.balance_usd = balance - renewal_cents
                        license.expires_at = license.expires_at + timedelta(days=30)
                        license.status = "active"

                        tx = BalanceTransaction(
                            client_id=client.id,
                            amount_cents=-renewal_cents,
                            reason="license_renewal",
                            invoice_id=license.license_key,
                        )
                        db.add(tx)
                        await db.commit()

                        # Notify user
                        if TELEGRAM_BOT_TOKEN and client.telegram_id:
                            msg = (
                                f"✅ <b>Лицензия продлена!</b>\n\n"
                                f"Ключ: <code>{license.license_key}</code>\n"
                                f"Списано: ${renewal_cents/100:.2f}\n"
                                f"Остаток баланса: ${client.balance_usd/100:.2f}\n"
                                f"Активна до: {(license.expires_at).strftime('%d.%m.%Y')}"
                            )
                            try:
                                async with httpx.AsyncClient() as hc:
                                    await hc.post(
                                        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                                        json={"chat_id": client.telegram_id, "text": msg, "parse_mode": "HTML"},
                                        timeout=10
                                    )
                            except Exception:
                                pass
                    else:
                        # Notify insufficient balance
                        if TELEGRAM_BOT_TOKEN and client.telegram_id:
                            needed = renewal_cents / 100
                            have = balance / 100
                            msg = (
                                f"⚠️ <b>Недостаточно средств для продления!</b>\n\n"
                                f"Ключ: <code>{license.license_key}</code>\n"
                                f"Истекает: {license.expires_at.strftime('%d.%m.%Y %H:%M')}\n"
                                f"Нужно: ${needed:.2f} | Баланс: ${have:.2f}\n\n"
                                f"Пополните баланс в боте @HAMELEONWEB_bot"
                            )
                            try:
                                async with httpx.AsyncClient() as hc:
                                    await hc.post(
                                        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                                        json={"chat_id": client.telegram_id, "text": msg, "parse_mode": "HTML"},
                                        timeout=10
                                    )
                            except Exception:
                                pass
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[auto_renew] error: {e}")

# ============ ADMIN/BOT ENDPOINTS ============

@app.post("/api/admin/issue-license")
async def admin_issue_license(request: Request, db: AsyncSession = Depends(get_db)):
    """Issue or extend a license for a client after confirmed payment (called by bot)"""
    body = await request.json()
    if body.get("secret") != JWT_SECRET:
        raise HTTPException(403, "Forbidden")

    client_id = int(body.get("client_id", 0))
    days = int(body.get("days", 30))
    invoice_id = body.get("invoice_id", "")

    # Check if client has an existing active license — extend it
    now = datetime.utcnow()
    result = await db.execute(
        select(License).where(
            License.client_id == client_id,
            License.status.in_(["active", "trial"]),
            License.expires_at > now,
        ).order_by(License.expires_at.desc())
    )
    existing = result.scalar_one_or_none()

    if existing:
        existing.expires_at = existing.expires_at + timedelta(days=days)
        existing.status = "active"
        await db.commit()
        return {
            "license_key": existing.license_key,
            "expires_at": existing.expires_at.isoformat(),
            "extended": True,
        }

    # No active license — create new one
    license = License(
        client_id=client_id,
        license_key=generate_license_key(),
        activated_at=now,
        expires_at=now + timedelta(days=days),
        status="active",
        trial_used=False,
    )
    db.add(license)
    await db.commit()
    return {
        "license_key": license.license_key,
        "expires_at": license.expires_at.isoformat(),
        "extended": False,
    }

@app.get("/api/admin/balance/{client_id}")
async def admin_get_balance(client_id: int, db: AsyncSession = Depends(get_db)):
    """Get client balance (used by bot)"""
    result = await db.execute(select(Client).where(Client.id == client_id))
    client = result.scalar_one_or_none()
    if not client:
        raise HTTPException(404, "Client not found")
    balance = (client.balance_usd or 0)
    return {"balance_usd": balance / 100, "balance_cents": balance}

@app.get("/api/admin/licenses/{client_id}")
async def admin_get_licenses(client_id: int, db: AsyncSession = Depends(get_db)):
    """Get licenses for a client (used by bot)"""
    result = await db.execute(
        select(License).where(License.client_id == client_id).order_by(License.id.desc())
    )
    licenses = result.scalars().all()
    return [
        {
            "license_key": lic.license_key,
            "status": lic.status,
            "expires_at": lic.expires_at.isoformat() if lic.expires_at else None,
            "activated_at": lic.activated_at.isoformat() if lic.activated_at else None,
            "trial_used": lic.trial_used,
        }
        for lic in licenses
    ]

@app.get("/api/admin/devices/{client_id}")
async def admin_get_devices(client_id: int, db: AsyncSession = Depends(get_db)):
    """Get devices for a client (used by bot)"""
    result = await db.execute(
        select(Device).where(Device.client_id == client_id).order_by(Device.last_seen.desc())
    )
    devices = result.scalars().all()
    return [
        {
            "device_id": d.device_id,
            "device_name": d.device_name or d.device_id,
            "last_seen": d.last_seen.isoformat() if d.last_seen else None,
            "first_login": d.first_login.isoformat() if d.first_login else None,
            "is_active": d.is_active,
        }
        for d in devices
    ]

# ============ PUBLIC ENDPOINTS ============

@app.get("/api/download/latest")
async def get_latest_download():
    """Get download info for the latest app version"""
    return {
        "version": "0.1.0",
        "download_url": "/download/HAMELEONWEB Setup 0.1.0.exe",
        "size_mb": 85,
        "release_date": "2026-06-16"
    }

# ============ ADMIN PANEL API ============

ADMIN_LOGIN = os.getenv("ADMIN_LOGIN", "kadmin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "alexey2000")
ADMIN_TOKEN_SECRET = os.getenv("ADMIN_TOKEN_SECRET", JWT_SECRET + "_admin")

class SiteVisit(Base):
    __tablename__ = "site_visits"
    id = Column(Integer, primary_key=True)
    ip = Column(String(64))
    path = Column(String(500))
    created_at = Column(DateTime, default=datetime.utcnow)

class DownloadLog(Base):
    __tablename__ = "download_logs"
    id = Column(Integer, primary_key=True)
    ip = Column(String(64))
    filename = Column(String(500))
    created_at = Column(DateTime, default=datetime.utcnow)

class AdminLoginRequest(BaseModel):
    login: str
    password: str

@app.post("/api/admin-panel/login")
async def admin_login(data: AdminLoginRequest):
    if data.login == ADMIN_LOGIN and data.password == ADMIN_PASSWORD:
        token = jwt.encode(
            {"sub": "admin", "exp": datetime.utcnow() + timedelta(hours=12)},
            ADMIN_TOKEN_SECRET, algorithm="HS256"
        )
        return {"token": token}
    raise HTTPException(401, "Invalid credentials")

def verify_admin_token(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    try:
        payload = jwt.decode(authorization[7:], ADMIN_TOKEN_SECRET, algorithms=["HS256"])
        if payload.get("sub") != "admin":
            raise HTTPException(401, "Unauthorized")
    except Exception:
        raise HTTPException(401, "Unauthorized")

@app.get("/api/admin-panel/stats")
async def admin_stats(db: AsyncSession = Depends(get_db), _=Depends(verify_admin_token)):
    users_count = (await db.execute(select(func.count(Client.id)))).scalar()
    licenses_count = (await db.execute(select(func.count(License.id)))).scalar()
    invoices_total = (await db.execute(select(func.count(Purchase.id)))).scalar()
    invoices_paid = (await db.execute(
        select(func.count(Purchase.id)).where(Purchase.payment_status == "finished")
    )).scalar()
    visits_count = (await db.execute(select(func.count(SiteVisit.id)))).scalar()
    downloads_count = (await db.execute(select(func.count(DownloadLog.id)))).scalar()
    return {
        "users": users_count,
        "licenses": licenses_count,
        "invoices_total": invoices_total,
        "invoices_paid": invoices_paid,
        "visits": visits_count,
        "downloads": downloads_count,
    }

@app.get("/api/admin-panel/users")
async def admin_users(db: AsyncSession = Depends(get_db), _=Depends(verify_admin_token)):
    result = await db.execute(select(Client).order_by(Client.created_at.desc()))
    clients = result.scalars().all()
    out = []
    for c in clients:
        lics = (await db.execute(
            select(func.count(License.id)).where(License.client_id == c.id)
        )).scalar()
        out.append({
            "id": c.id,
            "telegram_id": c.telegram_id,
            "username": c.username or "",
            "first_name": c.first_name or "",
            "last_name": c.last_name or "",
            "balance_usd": (c.balance_usd or 0) / 100,
            "licenses": lics,
            "created_at": c.created_at.strftime("%Y-%m-%d %H:%M") if c.created_at else "",
        })
    return out

@app.get("/api/admin-panel/invoices")
async def admin_invoices(db: AsyncSession = Depends(get_db), _=Depends(verify_admin_token)):
    result = await db.execute(select(Purchase).order_by(Purchase.created_at.desc()).limit(200))
    purchases = result.scalars().all()
    out = []
    for p in purchases:
        client = (await db.execute(select(Client).where(Client.id == p.client_id))).scalar_one_or_none()
        out.append({
            "id": p.id,
            "client": f"@{client.username}" if client and client.username else str(p.client_id),
            "amount": p.total_price_usd / 100,
            "status": p.payment_status,
            "invoice_id": p.invoice_id or "",
            "created_at": p.created_at.strftime("%Y-%m-%d %H:%M") if p.created_at else "",
        })
    return out

@app.post("/api/admin-panel/track-visit")
async def track_visit(request: Request, db: AsyncSession = Depends(get_db)):
    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "")
    path = (await request.json()).get("path", "/") if request.headers.get("content-type", "").startswith("application/json") else "/"
    db.add(SiteVisit(ip=ip[:64], path=str(path)[:500]))
    await db.commit()
    return {"ok": True}

@app.post("/api/admin-panel/track-download")
async def track_download(request: Request, db: AsyncSession = Depends(get_db)):
    ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "")
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    db.add(DownloadLog(ip=ip[:64], filename=str(body.get("filename", "unknown"))[:500]))
    await db.commit()
    return {"ok": True}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

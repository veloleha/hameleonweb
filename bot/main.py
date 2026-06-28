#!/usr/bin/env python3
"""
HAMELEONWEB Telegram Bot (Python + aiogram)
"""

import os
import json
import asyncio
import logging
import requests
import time
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv
from zoneinfo import ZoneInfo

load_dotenv(Path(__file__).parent / ".env")

os.environ.setdefault("TZ", "Europe/Kyiv")
try:
    time.tzset()
except AttributeError:
    pass

import httpx

from aiogram import Bot, Dispatcher, Router, F
from aiogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
ADMIN_ID = int(os.getenv("TELEGRAM_ADMIN_ID", "0"))
API_URL = os.getenv("API_URL", "http://127.0.0.1:8000").rstrip("/")
NOWPAYMENTS_API_KEY = os.getenv("NOWPAYMENTS_API_KEY", "")
JWT_SECRET = os.getenv("JWT_SECRET", "change_me")
BASE_DIR = Path(__file__).resolve().parent
KYIV_TZ = ZoneInfo("Europe/Kyiv")
TARIFFS_PATH = Path(
    os.getenv(
        "TARIFFS_PATH",
        str(BASE_DIR / "tariffs.json"),
    )
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

bot = Bot(token=BOT_TOKEN)
storage = MemoryStorage()
dp = Dispatcher(storage=storage)
router = Router()
dp.include_router(router)


def load_tariffs():
    try:
        with TARIFFS_PATH.open("r", encoding="utf-8") as f:
            tariffs = json.load(f)
        if isinstance(tariffs, list) and tariffs:
            return tariffs
    except Exception as exc:
        logger.warning("Failed to load tariffs from %s: %s", TARIFFS_PATH, exc)

    return [
        {
            "id": "solo",
            "name": "Однопользовательская",
            "price": "10",
            "period": "мес",
            "currency": "USDT",
            "badge": None,
            "desc": "Для одного пользователя на локальном ПК",
            "features": [
                "Любое количество аккаунтов WhatsApp",
                "Прокси для каждого аккаунта",
                "Автозапись звонков в MP3",
                "Portable EXE — без установки",
                "Обновления в течение срока лицензии",
            ],
            "primary": False,
            "cta": "Купить через Telegram",
        },
        {
            "id": "rds",
            "name": "Remote Desktop Server",
            "price": "300",
            "period": "мес / лицензия",
            "currency": "USDT",
            "badge": "Популярный выбор",
            "desc": "Многопользовательский RDS — несколько операторов на одном сервере",
            "features": [
                "Неограниченное число операторов на RDS",
                "Любое количество аккаунтов WhatsApp",
                "Прокси для каждого аккаунта",
                "Автозапись звонков в MP3",
                "Централизованное управление записями",
                "Приоритетная поддержка",
            ],
            "primary": True,
            "cta": "Купить через Telegram",
        },
    ]


def get_tariff(tariff_id):
    for tariff in load_tariffs():
        if str(tariff.get("id")) == str(tariff_id):
            return tariff
    return None


def format_kyiv_datetime(value):
    if not value:
        return "—"
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = datetime.fromisoformat(str(value))
        except Exception:
            return str(value)[:16]
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(KYIV_TZ).strftime("%d.%m.%Y %H:%M")


def get_tariff_unit_price(tariff, qty=1, is_first_month=False):
    return float(tariff.get("price", 0) or 0)


def get_tariff_total_price(tariff, qty):
    return get_tariff_unit_price(tariff, qty) * qty


def get_renewal_price_for_license(license_info):
    """Return renewal price (USD) for a single license based on its tariff_id.
    Falls back to current default if no tariff_id stored."""
    tariff_id = license_info.get("tariff_id")
    if tariff_id:
        tariff = get_tariff(tariff_id)
        if tariff:
            return float(tariff.get("price", 0) or 0)
    # Fallback: rds devices or package code
    if license_info.get("package_code") == "rds" or license_info.get("tariff_id") == "rds":
        return 300.0
    # Default to first tariff (solo)
    tariffs = load_tariffs()
    return float(tariffs[0].get("price", 10)) if tariffs else 10.0


def get_sufler_price() -> float:
    """Return current sufler addon price (USD) from tariffs."""
    tariff = get_tariff("sufler")
    if tariff:
        return float(tariff.get("price", 0) or 0)
    return 150.0


def build_order_description(title: str, lines: list[str], total_usd: float) -> str:
    parts = [f"{title}: "]
    parts.append("; ".join(line for line in lines if line))
    parts.append(f"Итого {total_usd:g} USDT")
    description = " ".join(part for part in parts if part)
    return description[:240]


async def fetch_device_name_map(client_id: int) -> dict:
    try:
        async with httpx.AsyncClient(timeout=10.0) as hc:
            resp = await hc.get(f"{API_URL}/api/admin/devices/{client_id}")
        devices = resp.json() if resp.status_code == 200 else []
    except Exception:
        return {}

    device_map = {}
    for device in devices:
        license_id = device.get("license_id")
        if license_id:
            device_map[int(license_id)] = device.get("device_name") or device.get("device_id") or "Устройство"
    return device_map


async def build_renew_receipt(client_id: int, licenses: list[dict], include_sufler: bool = False) -> tuple[str, list[str], float]:
    device_map = await fetch_device_name_map(client_id)
    lines = []
    total = 0.0
    sufler_price = get_sufler_price()

    for lic in licenses:
        unit_price = get_renewal_price_for_license(lic)
        expires = lic.get('expires_at', '—')[:10] if lic.get('expires_at') else '—'
        kind = "ДЕМО" if lic.get('status') == 'trial' else "ЛИЦЕНЗИЯ"
        license_key = lic.get('license_key', '—')
        device_name = device_map.get(int(lic.get('id', 0)), "Устройство")

        line = f"{device_name} — {kind} <code>{license_key}</code> (до {expires}) — ${unit_price:g} USDT"
        lines.append(line)
        total += unit_price

        if include_sufler:
            lines.append(f"  + Модуль суфлёра — ${sufler_price:g} USDT")
            total += sufler_price

    title = "Продление с суфлёром" if include_sufler else "Продление"
    description = build_order_description(title, lines, total)
    return description, lines, total


def create_nowpayments_payment(amount_usd: float, user_id: int, order_description: str = "") -> dict:
    """Создаёт платёж в NOWPayments"""
    try:
        headers = {
            'x-api-key': NOWPAYMENTS_API_KEY,
            'Content-Type': 'application/json'
        }
        data = {
            'price_amount': float(amount_usd),
            'price_currency': 'usd',
            'pay_currency': 'usdttrc20',
            'order_id': f'hameleon_{user_id}_{int(datetime.now().timestamp())}',
            'order_description': order_description or f'HAMELEONWEB order for user {user_id}',
        }
        response = requests.post(
            'https://api.nowpayments.io/v1/payment',
            json=data,
            headers=headers,
            timeout=20
        )
        if response.status_code in (200, 201):
            return response.json()
        logger.error(f"NOWPayments error: status={response.status_code} body={response.text}")
        try:
            err = response.json()
        except Exception:
            err = {'raw': response.text}
        return {'error': True, 'status_code': response.status_code, 'details': err}
    except Exception as e:
        logger.error(f"NOWPayments exception: {e}")
        return {'error': True, 'exception': str(e)}


# { payment_id -> {client_id, tg_id, chat_id, amount_usd, type: 'license'|'topup', tariff, qty, created_at} }
# Polling every 60 sec, payment lives 7 days
PAYMENT_POLL_INTERVAL = 60    # 1 minute
PAYMENT_TTL_DAYS = 7
pending_payments: dict = {}


def check_nowpayments_status(payment_id: str) -> dict:
    """Sync status check for NOWPayments payment"""
    try:
        headers = {'x-api-key': NOWPAYMENTS_API_KEY}
        resp = requests.get(f'https://api.nowpayments.io/v1/payment/{payment_id}', headers=headers, timeout=15)
        if resp.status_code == 200:
            return resp.json()
        return {'error': True, 'status_code': resp.status_code}
    except Exception as e:
        return {'error': True, 'exception': str(e)}


async def activate_after_payment(payment_id: str, info: dict):
    """Called when NOWPayments confirms payment. Credits balance and issues/renews license."""
    client_id = info['client_id']
    tg_id = info['tg_id']
    chat_id = info['chat_id']
    amount_usd = info['amount_usd']
    amount_cents = int(amount_usd * 100)
    ptype = info.get('type', 'topup')
    tariff = info.get('tariff', {})
    qty = int(info.get('qty', 1) or 1)

    try:
        credit_reason = 'topup'
        if ptype in ('renew', 'renew_base', 'renew_bundle'):
            credit_reason = 'license_renewal'

        # 1. Credit balance via API
        async with httpx.AsyncClient(timeout=15.0) as hc:
            await hc.post(f"{API_URL}/api/balance/credit", json={
                'secret': JWT_SECRET,
                'client_id': client_id,
                'amount_cents': amount_cents,
                'invoice_id': payment_id,
                'reason': credit_reason,
            })

        if ptype in ('renew', 'renew_base'):
            # Extend ALL existing active/trial licenses by 30 days
            async with httpx.AsyncClient(timeout=15.0) as hc:
                r = await hc.post(f"{API_URL}/api/admin/renew-all-licenses", json={
                    'secret': JWT_SECRET,
                    'client_id': client_id,
                    'days': 30,
                })
                ren_data = r.json() if r.status_code == 200 else {}

            renewed_count = ren_data.get('renewed', 0)
            lic_lines = ""
            for l in ren_data.get('licenses', []):
                exp = l.get('expires_at', '—')[:10]
                lic_lines += f"  • <code>{l.get('license_key', '—')}</code> до {exp}\n"
            msg = (
                f"✅ <b>Оплата прошла! Лицензии продлены.</b>\n\n"
                f"Продлено: <b>{renewed_count}</b> лицензий на 30 дней\n\n"
                f"{lic_lines}\n"
                f"Приложение обновится автоматически."
            )

        elif ptype == 'renew_bundle':
            async with httpx.AsyncClient(timeout=15.0) as hc:
                r = await hc.post(f"{API_URL}/api/admin/renew-all-licenses", json={
                    'secret': JWT_SECRET,
                    'client_id': client_id,
                    'days': 30,
                    'include_sufler': True,
                })
                ren_data = r.json() if r.status_code == 200 else {}

            renewed_count = ren_data.get('renewed', 0)
            addon_renewed = ren_data.get('addon_renewed', 0)
            lic_lines = ""
            for l in ren_data.get('licenses', []):
                exp = l.get('expires_at', '—')[:10]
                lic_lines += f"  • <code>{l.get('license_key', '—')}</code> до {exp}\n"
            msg = (
                f"✅ <b>Оплата прошла! Лицензии и суфлёр продлены.</b>\n\n"
                f"Продлено: <b>{renewed_count}</b> лицензий на 30 дней\n"
                f"Суфлёр продлён: <b>{addon_renewed}</b> лицензий\n\n"
                f"{lic_lines}\n"
                f"Приложение обновится автоматически."
            )

        elif ptype == 'license':
            license_days = 30

            # Create new license via API
            async with httpx.AsyncClient(timeout=15.0) as hc:
                r = await hc.post(f"{API_URL}/api/admin/issue-license", json={
                    'secret': JWT_SECRET,
                    'client_id': client_id,
                    'days': license_days,
                    'quantity': qty,
                    'invoice_id': payment_id,
                    'tariff_id': tariff.get('id'),
                })
                lic_data = r.json() if r.status_code == 200 else {}

            if qty > 1:
                keys = "\n".join(f"  • <code>{k}</code>" for k in lic_data.get('licenses', []))
                expires = lic_data.get('expires_at', '—')[:10] if lic_data.get('expires_at') else '—'
                msg = (
                    f"✅ <b>Оплата прошла! Лицензии выданы.</b>\n\n"
                    f"Тариф: <b>{tariff.get('name', '—')}</b>\n"
                    f"Количество: <b>{qty}</b>\n"
                    f"Активны до: <b>{expires}</b>\n\n"
                    f"{keys}\n\n"
                    f"Приложение обновится автоматически."
                )
            else:
                license_key = lic_data.get('license_key', '—')
                expires = lic_data.get('expires_at', '—')[:10] if lic_data.get('expires_at') else '—'
                msg = (
                    f"✅ <b>Оплата прошла! Лицензия выдана.</b>\n\n"
                    f"Тариф: <b>{tariff.get('name', '—')}</b>\n"
                    f"Ключ: <code>{license_key}</code>\n"
                    f"Активна до: <b>{expires}</b>\n\n"
                    f"Приложение обновится автоматически."
                )

        else:
            async with httpx.AsyncClient(timeout=10.0) as hc:
                r = await hc.get(f"{API_URL}/api/admin/balance/{client_id}")
                new_bal = r.json().get('balance_usd', 0) if r.status_code == 200 else 0
            msg = (
                f"✅ <b>Баланс пополнен!</b>\n\n"
                f"Зачислено: <b>${amount_usd:.2f}</b>\n"
                f"Текущий баланс: <b>${new_bal:.2f}</b>\n\n"
                f"Лицензия будет продлена автоматически при истечении срока."
            )

        await bot.send_message(chat_id=chat_id, text=msg, parse_mode="HTML")

    except Exception as e:
        logger.error(f"activate_after_payment error: {e}")


async def poll_payments():
    """Background task: check pending NOWPayments every 5 minutes, expire after 7 days"""
    FINISHED = {'finished', 'confirmed', 'partially_paid'}
    FAILED = {'failed', 'expired', 'refunded'}
    TTL_SECONDS = PAYMENT_TTL_DAYS * 24 * 3600
    while True:
        await asyncio.sleep(PAYMENT_POLL_INTERVAL)
        if not pending_payments:
            continue
        to_remove = []
        now = datetime.utcnow().timestamp()
        for pid, info in list(pending_payments.items()):
            try:
                # Check if payment exceeded 7-day TTL
                created_at = info.get('created_at', now)
                if now - created_at > TTL_SECONDS:
                    to_remove.append(pid)
                    try:
                        await bot.send_message(
                            chat_id=info['chat_id'],
                            text=(
                                f"⏰ <b>Время ожидания платежа истекло.</b>\n"
                                f"Платёж <code>{pid}</code> не был подтверждён в течение {PAYMENT_TTL_DAYS} дней.\n"
                                f"Если вы всё же оплатили — напишите в поддержку."
                            ),
                            parse_mode="HTML"
                        )
                    except Exception:
                        pass
                    logger.info(f"poll_payments: payment {pid} expired after {PAYMENT_TTL_DAYS} days")
                    continue

                data = await asyncio.to_thread(check_nowpayments_status, pid)
                status = str(data.get('payment_status', '')).lower()
                if status in FINISHED:
                    to_remove.append(pid)
                    await activate_after_payment(pid, info)
                elif status in FAILED:
                    to_remove.append(pid)
                    try:
                        await bot.send_message(
                            chat_id=info['chat_id'],
                            text=f"❌ Платёж <code>{pid}</code> не прошёл (статус: {status}).",
                            parse_mode="HTML"
                        )
                    except Exception:
                        pass
                else:
                    # Still waiting — log remaining time
                    elapsed_h = int((now - created_at) / 3600)
                    logger.debug(f"poll_payments: {pid} status={status!r} elapsed={elapsed_h}h")
            except Exception as e:
                logger.warning(f"poll_payments error pid={pid}: {e}")
        for pid in to_remove:
            pending_payments.pop(pid, None)


async def api_post(path: str, payload: dict):
    url = f"{API_URL}{path}"
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(url, json=payload)
        response.raise_for_status()
        return response.json()


async def safe_callback_answer(callback: CallbackQuery):
    try:
        await callback.answer()
    except Exception:
        pass

class BuyFlow(StatesGroup):
    selecting_package = State()
    selecting_quantity = State()
    confirming = State()

class RenewFlow(StatesGroup):
    selecting_mode = State()
    confirming = State()

# Main Menu
@router.message(Command("start"))
async def cmd_start(message: Message, tg_user=None):
    if tg_user is not None:
        tg_id = tg_user.id
        username = tg_user.username or ""
        first_name = tg_user.first_name
        last_name = tg_user.last_name
    else:
        tg_id = message.from_user.id
        username = message.from_user.username or ""
        first_name = message.from_user.first_name
        last_name = message.from_user.last_name

    balance_str = ""
    try:
        data_upsert = await api_post('/api/clients/upsert', {
            'telegram_id': tg_id, 'username': username,
            'first_name': first_name, 'last_name': last_name,
        })
        client_id = data_upsert.get('client_id')
        async with httpx.AsyncClient(timeout=8.0) as hc:
            r = await hc.get(f"{API_URL}/api/admin/balance/{client_id}")
            if r.status_code == 200:
                bal = r.json().get('balance_usd', 0)
                balance_str = f"\n\n💰 <b>Баланс:</b> ${bal:.2f}"
    except Exception as exc:
        logger.warning('Failed to sync client to API: %s', exc)

    text = f"""🎛️ <b>HAMELEONWEB</b>

👤 <b>Ваш ID:</b> <code>{tg_id}</code>
{f'👤 @{username}' if username else ''}{balance_str}

<b>Навигация:</b>
🛒 Купить лицензию — выбор пакета
🔄 Продлить подписку — продление активных лицензий
� Мои лицензии — список и ключи
 Мои устройства — привязанные ПК"""

    # Smart button: Renew if has active/trial licenses, else Buy
    smart_btn = {"text": "🛒 Купить лицензию", "callback_data": "menu:buy"}
    try:
        data_lic = await api_post('/api/clients/upsert', {
            'telegram_id': tg_id, 'username': username,
            'first_name': first_name, 'last_name': last_name,
        })
        cid_for_btn = data_lic.get('client_id')
        async with httpx.AsyncClient(timeout=6.0) as hc:
            r_l = await hc.get(f"{API_URL}/api/admin/licenses/{cid_for_btn}")
            lics_btn = r_l.json() if r_l.status_code == 200 else []
        has_active = any(l.get('status') in ('active', 'trial') for l in lics_btn)
        if has_active:
            smart_btn = {"text": "🔄 Продлить лицензии", "callback_data": "menu:renew"}
    except Exception:
        pass

    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [{"text": "🛒 Купить", "callback_data": "menu:buy"}, {"text": "📋 Лицензии", "callback_data": "menu:licenses"}],
        [smart_btn],
        [{"text": "📱 Устройства", "callback_data": "menu:devices"}],
        [{"text": "❓ Помощь", "callback_data": "menu:help"}]
    ])

    await message.answer(text, reply_markup=keyboard, parse_mode="HTML")

@router.callback_query(F.data == "nav:menu")
async def back_to_menu(callback: CallbackQuery):
    await safe_callback_answer(callback)
    await cmd_start(callback.message, tg_user=callback.from_user)

# Buy Flow
@router.callback_query(F.data == "menu:buy")
async def menu_buy(callback: CallbackQuery, state: FSMContext):
    await safe_callback_answer(callback)

    tariffs = load_tariffs()
    keyboard = []
    text = "🛒 <b>Выберите тариф с сайта:</b>\n\n"

    for tariff in tariffs:
        std_price = tariff['price']
        text += f"<b>{tariff['name']}</b>\n"
        if tariff.get("badge"):
            text += f"🏷 {tariff['badge']}\n"
        text += f"💰 ${std_price} {tariff.get('currency', 'USDT')} / {tariff.get('period', 'мес')}\n"
        text += f"{tariff.get('desc', '')}\n\n"
        keyboard.append([
            InlineKeyboardButton(
                text=f"🛒 {tariff['name']} — ${std_price} USDT",
                callback_data=f"pkg:{tariff['id']}"
            )
        ])

    keyboard.append([InlineKeyboardButton(text="◀️ Назад", callback_data="nav:menu")])

    await callback.message.edit_text(text, reply_markup=InlineKeyboardMarkup(inline_keyboard=keyboard), parse_mode="HTML")
    await state.set_state(BuyFlow.selecting_package)

@router.callback_query(F.data.startswith("pkg:"), BuyFlow.selecting_package)
async def select_package(callback: CallbackQuery, state: FSMContext):
    await safe_callback_answer(callback)
    tariff_id = callback.data.split(":", 1)[1]
    tariff = get_tariff(tariff_id)
    if not tariff:
        await callback.message.edit_text("❌ Тариф не найден. Попробуйте снова.", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="◀️ Назад", callback_data="menu:buy")]]))
        return

    await state.update_data(selected_tariff=tariff, qty=1)


    std_price = float(tariff.get('price', 0))
    pricing_text = f"💰 <b>${std_price:g} USDT / {tariff.get('period', 'мес')}</b>"
    qty_label = "количество лицензий"

    await callback.message.edit_text(
        f"<b>{tariff['name']}</b>\n\n"
        f"{pricing_text}\n\n"
        f"{tariff.get('desc', '')}\n\n"
        f"✏️ Введите {qty_label} цифрой:",
        
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "menu:buy"}]]),
        parse_mode="HTML"
    )
    await state.set_state(BuyFlow.selecting_quantity)



@router.message(BuyFlow.selecting_quantity, F.text.regexp(r"^\d+$"))
async def quantity_as_number(message: Message, state: FSMContext):
    data = await state.get_data()
    tariff = data.get("selected_tariff") or {}
    qty = int(message.text)

    if qty < 1:
        await message.answer("❌ Введите число больше 0.")
        return

    await state.update_data(qty=qty)
    unit = get_tariff_unit_price(tariff, qty)
    total = unit * qty
    item_name = tariff.get("name", "Лицензия")
    receipt = build_order_description(
        f"Покупка лицензии {item_name}",
        [f"{item_name} × {qty} — ${unit:g} USDT"],
        total,
    )

    await state.update_data(qty=qty, order_description=receipt)

    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [{"text": "💳 Оплатить (NOWPayments)", "callback_data": "pay:nowpayments"}],
        [{"text": "◀️ Назад", "callback_data": "menu:buy"}]
    ])

    await message.answer(
        f"📋 <b>Подтверждение</b>\n\n"
        f"Тариф: <b>{tariff.get('name', '—')}</b>\n"
        f"Количество: {qty} × ${unit:g} USDT\n"
        f"Итого: <b>${total:g} USDT</b>\n\n"
        f"Оплата криптовалютой USDT (TRC20)",
        reply_markup=keyboard,
        parse_mode="HTML"
    )
    await state.set_state(BuyFlow.confirming)


@router.callback_query(F.data == "pay:nowpayments", BuyFlow.confirming)
async def pay_nowpayments(callback: CallbackQuery, state: FSMContext):
    await safe_callback_answer(callback)

    if not NOWPAYMENTS_API_KEY:
        await callback.message.edit_text(
            "❌ Оплата временно недоступна. Обратитесь к администратору.",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "nav:menu"}]])
        )
        return

    data = await state.get_data()
    tariff = data.get("selected_tariff") or {}
    qty = data.get("qty", 1)
    total = get_tariff_total_price(tariff, qty)
    order_description = data.get("order_description") or build_order_description(
        f"Покупка {tariff.get('name', 'лицензии')}",
        [f"{tariff.get('name', 'Тариф')} × {qty} — ${float(tariff.get('price', 0) or 0):g} USDT"],
        total,
    )
    user_id = callback.from_user.id

    await callback.message.edit_text("⏳ Создаю платёж...")

    invoice = await asyncio.to_thread(create_nowpayments_payment, total, user_id, order_description)

    if invoice.get('error'):
        details = invoice.get('details') or invoice.get('exception') or ''
        err_msg = details.get('message', str(details)) if isinstance(details, dict) else str(details)
        await callback.message.edit_text(
            f"❌ Не удалось создать платёж:\n<code>{err_msg}</code>",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "nav:menu"}]]),
            parse_mode="HTML"
        )
        return

    payment_id = str(invoice.get('payment_id', ''))
    pay_address = invoice.get('pay_address', '—')
    pay_amount = invoice.get('pay_amount', total)
    pay_currency = str(invoice.get('pay_currency', 'USDTTRC20')).upper()
    network = str(invoice.get('network', 'TRC20')).upper()

    # Register for background polling
    if payment_id:
        data_st = await state.get_data()
        ptype = 'license'
        pending_payments[payment_id] = {
            'client_id': data_st.get('client_id', user_id),
            'tg_id': user_id,
            'chat_id': callback.message.chat.id,
            'amount_usd': total,
            'type': ptype,
            'tariff': tariff,
            'qty': qty,
            'order_description': order_description,
            'created_at': datetime.utcnow().timestamp(),
        }

    await state.clear()
    await callback.message.edit_text(
        f"✅ <b>Платёж создан!</b>\n\n"
        f"ID: <code>{payment_id}</code>\n\n"
        f"Отправьте: <b>{pay_amount} {pay_currency}</b>\n"
        f"Сеть: <b>{network}</b>\n"
        f"Адрес:\n<code>{pay_address}</code>\n\n"
        f"⏰ Платёж действителен 1 час\n"
        f"После оплаты заказ будет активирован автоматически и придёт уведомление.",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ В меню", "callback_data": "nav:menu"}]]),
        parse_mode="HTML"
    )


@router.message(BuyFlow.selecting_quantity)
async def quantity_text_invalid(message: Message):
    await message.answer("❌ Введите количество цифрой. Например: 1, 5 или 10.")

@router.callback_query(F.data == "menu:licenses")
async def menu_licenses(callback: CallbackQuery):
    await safe_callback_answer(callback)
    tg_id = callback.from_user.id

    text = "📋 <b>Ваши лицензии:</b>\n\n"
    try:
        data = await api_post('/api/clients/upsert', {
            'telegram_id': tg_id,
            'username': callback.from_user.username or '',
            'first_name': callback.from_user.first_name,
            'last_name': callback.from_user.last_name,
        })
        client_id = data.get('client_id')
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{API_URL}/api/admin/licenses/{client_id}")
            licenses = resp.json() if resp.status_code == 200 else []
        if not licenses:
            text += "Лицензий пока нет.\n"
        for lic in licenses:
            status = lic.get('status', '')
            icon = '✅' if status in ('active', 'trial') else '❌'
            kind = 'ДЕМО' if status == 'trial' else 'ЛИЦЕНЗИЯ'
            expires = lic.get('expires_at', '—')[:10] if lic.get('expires_at') else '—'
            text += f"{icon} <code>{lic.get('license_key', '—')}</code>\n"
            text += f"   Тип: {kind} | До: {expires}\n\n"
    except Exception as exc:
        text += f"Ошибка загрузки: {exc}\n"

    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [{"text": "🔑 Получить код для входа", "callback_data": "code:generate"}],
        [{"text": "◀️ Назад", "callback_data": "nav:menu"}]
    ])
    await callback.message.edit_text(text, reply_markup=keyboard, parse_mode="HTML")

@router.callback_query(F.data == "code:generate")
async def generate_code(callback: CallbackQuery):
    await safe_callback_answer(callback)
    
    import random
    code = str(random.randint(100000, 999999))
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [{"text": "◀️ К лицензиям", "callback_data": "menu:licenses"}]
    ])
    
    await callback.message.edit_text(
        f"🔐 <b>Код для входа</b>\n\n"
        f"<code>{code}</code>\n\n"
        f"⏱ Действителен 5 минут\n"
        f"Введите этот код в приложении HAMELEONWEB",
        reply_markup=keyboard,
        parse_mode="HTML"
    )

@router.callback_query(F.data == "menu:renew")
async def menu_renew(callback: CallbackQuery, state: FSMContext):
    await safe_callback_answer(callback)
    tg_id = callback.from_user.id

    try:
        data = await api_post('/api/clients/upsert', {
            'telegram_id': tg_id, 'username': callback.from_user.username or '',
            'first_name': callback.from_user.first_name, 'last_name': callback.from_user.last_name,
        })
        client_id = data.get('client_id')
        async with httpx.AsyncClient(timeout=10.0) as hc:
            r_lic = await hc.get(f"{API_URL}/api/admin/licenses/{client_id}")
            licenses = r_lic.json() if r_lic.status_code == 200 else []
    except Exception as exc:
        await callback.message.edit_text(
            f"❌ Ошибка загрузки лицензий: {exc}",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "nav:menu"}]])
        )
        return

    active_lics = [l for l in licenses if l.get('status') in ('active', 'trial')]
    if not active_lics:
        await callback.message.edit_text(
            "ℹ️ <b>Нет активных лицензий для продления.</b>\n\nСначала купите лицензию.",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [{"text": "🛒 Купить", "callback_data": "menu:buy"}],
                [{"text": "◀️ Назад", "callback_data": "nav:menu"}]
            ]),
            parse_mode="HTML"
        )
        return

    lic_lines = ""
    base_total = 0.0
    for l in active_lics:
        expires = l.get('expires_at', '—')[:10] if l.get('expires_at') else '—'
        kind = "ДЕМО" if l.get('status') == 'trial' else "ЛИЦЕНЗИЯ"
        unit_price = get_renewal_price_for_license(l)
        base_total += unit_price
        lic_lines += f"  • {kind} <code>{l.get('license_key', '—')}</code> (до {expires}) — ${unit_price:g} USDT\n"

    sufler_total = base_total + len(active_lics) * get_sufler_price()

    await state.update_data(renew_client_id=client_id, renew_count=len(active_lics), renew_licenses=active_lics)
    await state.set_state(RenewFlow.confirming)

    await callback.message.edit_text(
        f"🔄 <b>Продление подписки</b>\n\n"
        f"{lic_lines}\n"
        f"Лицензий для продления: <b>{len(active_lics)}</b>\n"
        f"Стандартное продление: <b>${base_total:g} USDT</b>\n"
        f"Продление с суфлёром: <b>${sufler_total:g} USDT</b>\n"
        f"Выберите вариант оплаты:",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [{"text": f"💳 Продлить стандартную — ${base_total:g} USDT", "callback_data": "renew:base"}],
            [{"text": f"🎤 Продлить с суфлёром — ${sufler_total:g} USDT", "callback_data": "renew:sufler"}],
            [{"text": "◀️ Назад", "callback_data": "nav:menu"}]
        ]),
        parse_mode="HTML"
    )


@router.callback_query(F.data == "renew:base")
async def renew_base(callback: CallbackQuery, state: FSMContext):
    await safe_callback_answer(callback)
    data = await state.get_data()
    client_id = data.get("renew_client_id")
    licenses = data.get("renew_licenses") or []
    if not client_id or not licenses:
        await callback.message.edit_text(
            "❌ Не удалось определить лицензии для продления.",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "menu:renew"}]])
        )
        return

    receipt, lines, total = await build_renew_receipt(client_id, licenses, include_sufler=False)
    await state.update_data(renew_total=total, renew_type="renew_base", renew_receipt=receipt, renew_receipt_lines=lines)
    await state.set_state(RenewFlow.confirming)

    items_block = "\n".join(f"• {line}" for line in lines)
    await callback.message.edit_text(
        f"📋 <b>Подтверждение оплаты</b>\n\n"
        f"{items_block}\n\n"
        f"Итого: <b>${total:g} USDT</b>\n\n"
        f"После оплаты стандартные лицензии будут продлены на 30 дней.",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [{"text": f"💳 Оплатить ${total:g} USDT", "callback_data": "renew:pay"}],
            [{"text": "◀️ Назад", "callback_data": "menu:renew"}],
        ]),
        parse_mode="HTML"
    )


@router.callback_query(F.data == "renew:sufler")
async def renew_sufler(callback: CallbackQuery, state: FSMContext):
    await safe_callback_answer(callback)
    data = await state.get_data()
    client_id = data.get("renew_client_id")
    licenses = data.get("renew_licenses") or []
    if not client_id or not licenses:
        await callback.message.edit_text(
            "❌ Не удалось определить лицензии для продления.",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "menu:renew"}]])
        )
        return

    receipt, lines, total = await build_renew_receipt(client_id, licenses, include_sufler=True)
    await state.update_data(renew_total=total, renew_type="renew_bundle", renew_receipt=receipt, renew_receipt_lines=lines)
    await state.set_state(RenewFlow.confirming)

    items_block = "\n".join(f"• {line}" for line in lines)
    await callback.message.edit_text(
        f"📋 <b>Подтверждение оплаты</b>\n\n"
        f"{items_block}\n\n"
        f"Итого: <b>${total:g} USDT</b>\n\n"
        f"После оплаты лицензии и модуль суфлёра будут продлены на 30 дней.",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [{"text": f"💳 Оплатить ${total:g} USDT", "callback_data": "renew:pay"}],
            [{"text": "◀️ Назад", "callback_data": "menu:renew"}],
        ]),
        parse_mode="HTML"
    )
@router.callback_query(F.data == "renew:pay", RenewFlow.confirming)
async def renew_pay(callback: CallbackQuery, state: FSMContext):
    await safe_callback_answer(callback)
    if not NOWPAYMENTS_API_KEY:
        await callback.message.edit_text(
            "❌ Оплата временно недоступна. Обратитесь к администратору.",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "nav:menu"}]])
        )
        return

    data = await state.get_data()
    total = data.get('renew_total', 0)
    client_id = data.get('renew_client_id')
    renew_type = data.get('renew_type', 'renew')
    renew_receipt_lines = data.get('renew_receipt_lines') or [f"Лицензии на сумму ${total:g} USDT"]
    order_description = data.get('renew_receipt') or build_order_description(
        "Продление",
        renew_receipt_lines,
        total,
    )
    tg_id = callback.from_user.id

    await callback.message.edit_text("⏳ Создаю счёт на продление...")

    invoice = await asyncio.to_thread(create_nowpayments_payment, total, tg_id, order_description)

    if invoice.get('error'):
        details = invoice.get('details') or invoice.get('exception') or ''
        err_msg = details.get('message', str(details)) if isinstance(details, dict) else str(details)
        await callback.message.edit_text(
            f"❌ Не удалось создать платёж:\n<code>{err_msg}</code>",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "nav:menu"}]]),
            parse_mode="HTML"
        )
        await state.clear()
        return

    payment_id = str(invoice.get('payment_id', ''))
    pay_address = invoice.get('pay_address', '—')
    pay_amount = invoice.get('pay_amount', total)
    pay_currency = str(invoice.get('pay_currency', 'USDTTRC20')).upper()
    network = str(invoice.get('network', 'TRC20')).upper()

    if payment_id:
        pending_payments[payment_id] = {
            'client_id': client_id,
            'tg_id': tg_id,
            'chat_id': callback.message.chat.id,
            'amount_usd': total,
            'type': renew_type,
            'order_description': order_description,
            'created_at': datetime.utcnow().timestamp(),
        }

    items_block = "\n".join(f"• {line}" for line in renew_receipt_lines)

    await state.clear()
    await callback.message.edit_text(
        f"✅ <b>Счёт на продление создан!</b>\n\n"
        f"📋 <b>Чек:</b>\n{items_block}\n\n"
        f"Итого: <b>${total:g} USDT</b>\n\n"
        f"ID: <code>{payment_id}</code>\n\n"
        f"Отправьте: <b>{pay_amount} {pay_currency}</b>\n"
        f"Сеть: <b>{network}</b>\n"
        f"Адрес:\n<code>{pay_address}</code>\n\n"
        f"⏰ Счёт действителен 1 час\n"
        f"После оплаты заказ будет продлён автоматически.",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ В меню", "callback_data": "nav:menu"}]]),
        parse_mode="HTML"
    )


@router.callback_query(F.data == "menu:orders")
async def menu_orders(callback: CallbackQuery):
    await safe_callback_answer(callback)
    keyboard = InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "nav:menu"}]])
    await callback.message.edit_text("💳 <b>История покупок</b>\n\nПока пусто.", reply_markup=keyboard)

async def get_client_id(tg_id: int, username: str, first_name: str, last_name: str) -> int:
    data = await api_post('/api/clients/upsert', {
        'telegram_id': tg_id,
        'username': username or '',
        'first_name': first_name,
        'last_name': last_name,
    })
    return data.get('client_id')


async def show_devices(target, client_id: int):
    """Show device list with unbind buttons. target = Message or CallbackQuery."""
    text = "📱 <b>Привязанные устройства:</b>\n\n"
    keyboard_rows = []
    devices = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as hc:
            resp = await hc.get(f"{API_URL}/api/admin/devices/{client_id}")
            devices = resp.json() if resp.status_code == 200 else []

        if not devices:
            text += "Нет зарегистрированных устройств.\n\nУстройство появляется автоматически при первом входе в приложение HAMELEONWEB."
        else:
            for i, dev in enumerate(devices, 1):
                name = dev.get('device_name') or dev.get('device_id', '—')
                dev_id = dev.get('device_id', '')
                last = format_kyiv_datetime(dev.get('last_seen'))
                bound = "🔗 привязана" if dev.get('license_id') else "⛓️ не привязана"
                text += f"<b>{i}. {name}</b>\n"
                text += f"   Лицензия: {bound}\n"
                text += f"   Последний вход: {last}\n\n"
                if dev.get('license_id'):
                    keyboard_rows.append([InlineKeyboardButton(
                        text=f"🔓 Отвязать {name[:25]}",
                        callback_data=f"unbind:{client_id}:{dev_id}"
                    )])
    except Exception as exc:
        text += f"Ошибка загрузки: {exc}\n"

    # Show bind button only if there are unbound devices
    has_unbound = any(not dev.get('license_id') for dev in devices)
    if has_unbound:
        keyboard_rows.append([InlineKeyboardButton(text="🔗 Привязать устройства к лицензии", callback_data=f"bind_all:{client_id}")])
    keyboard_rows.append([InlineKeyboardButton(text="🔄 Обновить", callback_data="menu:devices")])
    keyboard_rows.append([InlineKeyboardButton(text="◀️ Назад", callback_data="nav:menu")])
    kb = InlineKeyboardMarkup(inline_keyboard=keyboard_rows)

    if hasattr(target, 'message'):
        try:
            await target.message.edit_text(text, reply_markup=kb, parse_mode="HTML")
        except Exception as e:
            if "message is not modified" in str(e).lower():
                await target.answer("✅ Список актуален", show_alert=False)
            else:
                raise
    else:
        await target.answer(text, reply_markup=kb, parse_mode="HTML")


@router.callback_query(F.data == "menu:devices")
async def menu_devices(callback: CallbackQuery):
    await safe_callback_answer(callback)
    tg_id = callback.from_user.id
    try:
        client_id = await get_client_id(
            tg_id,
            callback.from_user.username or '',
            callback.from_user.first_name,
            callback.from_user.last_name,
        )
        await show_devices(callback, client_id)
    except Exception as exc:
        await callback.message.edit_text(
            f"❌ Ошибка: {exc}",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "nav:menu"}]])
        )


@router.callback_query(F.data.startswith("bind_all:"))
async def bind_all_devices(callback: CallbackQuery):
    await safe_callback_answer(callback)
    client_id = int(callback.data.split(":", 1)[1])
    try:
        async with httpx.AsyncClient(timeout=15.0) as hc:
            r = await hc.post(f"{API_URL}/api/admin/bind-all-devices", json={
                "secret": JWT_SECRET,
                "client_id": client_id,
            })
        data = r.json() if r.status_code == 200 else {}
        bound = data.get("bound", 0)
        skipped = data.get("skipped", 0)
        no_slots = data.get("no_slots", 0)
        text = (
            f"🔗 <b>Привязка завершена</b>\n\n"
            f"✅ Привязано: <b>{bound}</b>\n"
            f"⏭ Уже было привязано: <b>{skipped}</b>\n"
            f"❌ Нет свободных слотов: <b>{no_slots}</b>\n\n"
        )
        if no_slots:
            text += "Для устройств без слота нужно купить дополнительные лицензии."
        await callback.message.edit_text(
            text,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="📱 Устройства", callback_data="menu:devices")],
                [InlineKeyboardButton(text="◀️ Меню", callback_data="nav:menu")],
            ]),
            parse_mode="HTML"
        )
    except Exception as exc:
        await callback.message.edit_text(
            f"❌ Ошибка: {exc}",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="◀️ Назад", callback_data="menu:devices")]])
        )


@router.callback_query(F.data.startswith("unbind:"))
async def unbind_confirm(callback: CallbackQuery):
    await safe_callback_answer(callback)
    # unbind:<client_id>:<device_id>
    parts = callback.data.split(":", 2)
    if len(parts) < 3:
        return
    client_id_str, device_id = parts[1], parts[2]
    name_short = device_id[:30]

    kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Да, отвязать", callback_data=f"unbind_ok:{client_id_str}:{device_id}"),
            InlineKeyboardButton(text="❌ Отмена", callback_data="menu:devices"),
        ]
    ])
    await callback.message.edit_text(
        f"⚠️ <b>Отвязать устройство?</b>\n\n"
        f"<code>{name_short}</code>\n\n"
        f"Лицензия будет освобождена. Устройство перестанет работать до следующего входа в приложение "
        f"(если есть свободный слот — привяжется автоматически).",
        reply_markup=kb,
        parse_mode="HTML"
    )


@router.callback_query(F.data.startswith("unbind_ok:"))
async def unbind_execute(callback: CallbackQuery):
    await safe_callback_answer(callback)
    parts = callback.data.split(":", 2)
    if len(parts) < 3:
        return
    client_id_str, device_id = parts[1], parts[2]
    client_id = int(client_id_str)

    try:
        async with httpx.AsyncClient(timeout=10.0) as hc:
            r = await hc.post(f"{API_URL}/api/admin/unbind-device", json={
                "secret": JWT_SECRET,
                "client_id": client_id,
                "device_id": device_id,
            })
        if r.status_code == 200:
            await callback.message.edit_text(
                f"✅ <b>Устройство отвязано.</b>\n\n"
                f"<code>{device_id[:40]}</code>\n\n"
                f"Лицензия освобождена. При следующем запуске приложения устройство получит свободный слот.",
                reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                    [InlineKeyboardButton(text="📱 Устройства", callback_data="menu:devices")],
                    [InlineKeyboardButton(text="◀️ Меню", callback_data="nav:menu")],
                ]),
                parse_mode="HTML"
            )
        else:
            raise Exception(f"HTTP {r.status_code}: {r.text}")
    except Exception as exc:
        await callback.message.edit_text(
            f"❌ Ошибка при отвязке: {exc}",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="◀️ Назад", callback_data="menu:devices")]])
        )

@router.callback_query(F.data == "menu:trial")
async def menu_trial(callback: CallbackQuery):
    await safe_callback_answer(callback)
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [{"text": "✅ Активировать", "callback_data": "trial:activate"}],
        [{"text": "◀️ Назад", "callback_data": "nav:menu"}]
    ])
    await callback.message.edit_text(
        "🧪 <b>Пробный период</b>\n\n"
        "7 дней бесплатно\n"
        "1 устройство, 1 WA аккаунт\n\n"
        "Активировать?",
        reply_markup=keyboard
    )

@router.callback_query(F.data == "menu:help")
async def menu_help(callback: CallbackQuery):
    await safe_callback_answer(callback)
    await callback.message.edit_text(
        "❓ <b>Помощь</b>\n\n"
        "<b>Как войти в приложение:</b>\n"
        "1. Скачайте HAMELEONWEB.exe\n"
        "2. Введите ваш Telegram ID\n"
        "3. Получите код в боте\n"
        "4. Введите код в приложении\n\n"
        "<b>Поддержка:</b> @admin",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "nav:menu"}]])
    )

# Track which clients already got expiry warning today to avoid spam
_expiry_warned: dict = {}  # client_id -> date str

async def check_expiry_warnings():
    """Every hour: warn clients whose license/trial expires in <= 3 days."""
    while True:
        await asyncio.sleep(3600)
        try:
            async with httpx.AsyncClient(timeout=15.0) as hc:
                r = await hc.get(f"{API_URL}/api/admin/expiring-licenses",
                                  params={"days": 3, "secret": JWT_SECRET})
                if r.status_code != 200:
                    continue
                items = r.json()  # [{client_id, telegram_id, license_key, expires_at, status, device_count}]
            today = datetime.utcnow().strftime("%Y-%m-%d")
            for item in items:
                cid = item.get("client_id")
                tg_id = item.get("telegram_id")
                if not tg_id:
                    continue
                # Only warn once per day
                if _expiry_warned.get(cid) == today:
                    continue
                _expiry_warned[cid] = today
                expires_at = format_kyiv_datetime(item.get("expires_at"))
                kind = "ДЕМО" if item.get("status") == "trial" else "лицензия"
                device_count = item.get("device_count", 1)
                unit_price = get_renewal_price_for_license(item)
                total = unit_price * max(device_count, 1)
                try:
                    await bot.send_message(
                        chat_id=tg_id,
                        text=(
                            f"⚠️ <b>Внимание!</b> Ваш {kind} заканчивается\n"
                            f"📅 Дата окончания: <b>{expires_at}</b>\n"
                            f"📱 Устройств: <b>{device_count}</b>\n\n"
                            f"Чтобы не потерять доступ — продлите подписку.\n"
                            f"Стоимость продления: <b>${total:g} USDT</b>"
                        ),
                        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                            [{"text": f"🔄 Продлить за ${total:g} USDT", "callback_data": "menu:renew"}],
                            [{"text": "◀️ В меню", "callback_data": "nav:menu"}],
                        ]),
                        parse_mode="HTML"
                    )
                except Exception as e:
                    logger.warning("expiry warning failed for tg_id=%s: %s", tg_id, e)
        except Exception as e:
            logger.warning("check_expiry_warnings error: %s", e)


async def main():
    logger.info("Starting HAMELEONWEB Bot...")
    asyncio.create_task(poll_payments())
    asyncio.create_task(check_expiry_warnings())
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())

#!/usr/bin/env python3
"""
HAMELEONWEB Telegram Bot (Python + aiogram)
"""

import os
import json
import asyncio
import logging
import requests
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

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
BASE_DIR = Path(__file__).resolve().parents[2]
TARIFFS_PATH = Path(
    os.getenv(
        "TARIFFS_PATH",
        str(BASE_DIR / "whatsapp-manager-backup-2026-06-11_23-29-19" / "сайт" / "public" / "tariffs.json"),
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
            "bulk": "250 USDT / мес при покупке от 5 лицензий",
        },
    ]


def get_tariff(tariff_id):
    for tariff in load_tariffs():
        if str(tariff.get("id")) == str(tariff_id):
            return tariff
    return None


def get_tariff_unit_price(tariff, qty=1):
    base_price = float(tariff.get("price", 0) or 0)
    bulk_min_qty = int(tariff.get("bulk_min_qty", 0) or 0)
    bulk_price = tariff.get("bulk_price")

    if bulk_price is not None and bulk_min_qty and qty >= bulk_min_qty:
        try:
            return float(bulk_price)
        except (TypeError, ValueError):
            return base_price

    return base_price


def get_tariff_total_price(tariff, qty):
    return get_tariff_unit_price(tariff, qty) * qty


def create_nowpayments_payment(amount_usd: float, user_id: int) -> dict:
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
            'order_description': f'HAMELEONWEB license for user {user_id}',
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

    try:
        # 1. Credit balance via API
        async with httpx.AsyncClient(timeout=15.0) as hc:
            await hc.post(f"{API_URL}/api/balance/credit", json={
                'secret': JWT_SECRET,
                'client_id': client_id,
                'amount_cents': amount_cents,
                'invoice_id': payment_id,
                'reason': 'topup',
            })

        if ptype == 'license':
            tariff = info.get('tariff', {})
            qty = info.get('qty', 1)
            license_days = 30 * qty

            # 2. Create license via API
            async with httpx.AsyncClient(timeout=15.0) as hc:
                r = await hc.post(f"{API_URL}/api/admin/issue-license", json={
                    'secret': JWT_SECRET,
                    'client_id': client_id,
                    'days': license_days,
                    'invoice_id': payment_id,
                })
                lic_data = r.json() if r.status_code == 200 else {}

            license_key = lic_data.get('license_key', '—')
            expires = lic_data.get('expires_at', '—')[:10] if lic_data.get('expires_at') else '—'
            msg = (
                f"✅ <b>Оплата прошла! Лицензия выдана.</b>\n\n"
                f"Тариф: <b>{tariff.get('name', '—')}</b>\n"
                f"Ключ: <code>{license_key}</code>\n"
                f"Активна до: <b>{expires}</b>\n\n"
                f"Введите ключ в приложении HAMELEONWEB."
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

class TopupFlow(StatesGroup):
    entering_amount = State()

# Main Menu
@router.message(Command("start"))
async def cmd_start(message: Message):
    tg_id = message.from_user.id
    username = message.from_user.username or ""

    balance_str = ""
    try:
        data_upsert = await api_post('/api/clients/upsert', {
            'telegram_id': tg_id, 'username': username,
            'first_name': message.from_user.first_name, 'last_name': message.from_user.last_name,
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
� Баланс — пополнить для автопродления
� Мои лицензии — список и ключи
 Мои устройства — привязанные ПК
🧪 Пробный период — 7 дней бесплатно"""

    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [{"text": "🛒 Купить", "callback_data": "menu:buy"}, {"text": "📋 Лицензии", "callback_data": "menu:licenses"}],
        [{"text": "� Пополнить баланс", "callback_data": "menu:topup"}],
        [{"text": "📱 Устройства", "callback_data": "menu:devices"}, {"text": "🧪 Пробный период", "callback_data": "menu:trial"}],
        [{"text": "❓ Помощь", "callback_data": "menu:help"}]
    ])

    await message.answer(text, reply_markup=keyboard, parse_mode="HTML")

@router.callback_query(F.data == "nav:menu")
async def back_to_menu(callback: CallbackQuery):
    await safe_callback_answer(callback)
    await cmd_start(callback.message)

# Buy Flow
@router.callback_query(F.data == "menu:buy")
async def menu_buy(callback: CallbackQuery, state: FSMContext):
    await safe_callback_answer(callback)

    tariffs = load_tariffs()
    keyboard = []
    text = "🛒 <b>Выберите тариф с сайта:</b>\n\n"

    for tariff in tariffs:
        text += f"<b>{tariff['name']}</b> — ${tariff['price']} {tariff.get('currency', 'USDT')}\n"
        text += f"⏱ {tariff.get('period', '')}\n"
        if tariff.get("badge"):
            text += f"🏷 {tariff['badge']}\n"
        if tariff.get("bulk"):
            text += f"{tariff['bulk']}\n"
        text += f"{tariff.get('desc', '')}\n\n"
        keyboard.append([
            InlineKeyboardButton(
                text=f"🛒 {tariff['name']} — ${tariff['price']}",
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

    unit_1 = get_tariff_unit_price(tariff, 1)
    unit_2 = get_tariff_unit_price(tariff, 2)
    unit_3 = get_tariff_unit_price(tariff, 3)
    unit_5 = get_tariff_unit_price(tariff, 5)
    unit_10 = get_tariff_unit_price(tariff, 10)
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [{"text": f"1 (${unit_1 * 1:g})", "callback_data": "qty:1"}, {"text": f"2 (${unit_2 * 2:g})", "callback_data": "qty:2"}, {"text": f"3 (${unit_3 * 3:g})", "callback_data": "qty:3"}],
        [{"text": f"5 (${unit_5 * 5:g})", "callback_data": "qty:5"}, {"text": f"10 (${unit_10 * 10:g})", "callback_data": "qty:10"}],
        [{"text": "◀️ Назад", "callback_data": "menu:buy"}]
    ])
    
    await callback.message.edit_text(
        f"<b>Выберите количество:</b>\n\n"
        f"Тариф: <b>{tariff['name']}</b>\n"
        f"Цена за 1: ${tariff['price']} {tariff.get('currency', 'USDT')}\n"
        f"{tariff.get('desc', '')}\n"
        f"{tariff.get('bulk', '')}\n\n"
        f"Можно просто отправить цифру в чат, например: 1, 5 или 10.",
        reply_markup=keyboard,
        parse_mode="HTML"
    )
    await state.set_state(BuyFlow.selecting_quantity)

@router.callback_query(F.data.startswith("qty:"), BuyFlow.selecting_quantity)
async def select_qty(callback: CallbackQuery, state: FSMContext):
    await safe_callback_answer(callback)
    qty = int(callback.data.split(":")[1])
    data = await state.get_data()
    tariff = data.get("selected_tariff") or {}
    await state.update_data(qty=qty)
    total = get_tariff_total_price(tariff, qty)
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [{"text": "💳 Оплатить (NOWPayments)", "callback_data": "pay:nowpayments"}],
        [{"text": "◀️ Назад", "callback_data": "menu:buy"}]
    ])
    
    await callback.message.edit_text(
        f"📋 <b>Подтверждение</b>\n\n"
        f"Тариф: <b>{tariff.get('name', '—')}</b>\n"
        f"Количество: {qty}\n"
        f"Итого: ${total:g} {tariff.get('currency', 'USDT')}\n\n"
        f"Оплата криптовалютой USDT (TRC20)",
        reply_markup=keyboard,
        parse_mode="HTML"
    )
    await state.set_state(BuyFlow.confirming)


@router.message(BuyFlow.selecting_quantity, F.text.regexp(r"^\d+$"))
async def quantity_as_number(message: Message, state: FSMContext):
    data = await state.get_data()
    tariff = data.get("selected_tariff") or {}
    qty = int(message.text)

    if qty < 1:
        await message.answer("❌ Введите число больше 0.")
        return

    total = get_tariff_total_price(tariff, qty)

    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [{"text": "💳 Оплатить (NOWPayments)", "callback_data": "pay:nowpayments"}],
        [{"text": "◀️ Назад", "callback_data": "menu:buy"}]
    ])

    await message.answer(
        f"📋 <b>Подтверждение</b>\n\n"
        f"Тариф: <b>{tariff.get('name', '—')}</b>\n"
        f"Количество: {qty}\n"
        f"Итого: ${total:g} {tariff.get('currency', 'USDT')}\n\n"
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
    user_id = callback.from_user.id

    await callback.message.edit_text("⏳ Создаю платёж...")

    invoice = await asyncio.to_thread(create_nowpayments_payment, total, user_id)

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
        pending_payments[payment_id] = {
            'client_id': data_st.get('client_id', user_id),
            'tg_id': user_id,
            'chat_id': callback.message.chat.id,
            'amount_usd': total,
            'type': 'license',
            'tariff': tariff,
            'qty': qty,
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
        f"После оплаты лицензия будет активирована автоматически и придёт уведомление.",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ В меню", "callback_data": "nav:menu"}]]),
        parse_mode="HTML"
    )


@router.message(BuyFlow.selecting_quantity)
async def quantity_text_invalid(message: Message):
    await message.answer("Введите количество лицензий **цифрой**. Например: 1, 5 или 10.")

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

@router.callback_query(F.data == "menu:topup")
async def menu_topup(callback: CallbackQuery, state: FSMContext):
    await safe_callback_answer(callback)
    tg_id = callback.from_user.id

    balance_line = ""
    try:
        data = await api_post('/api/clients/upsert', {
            'telegram_id': tg_id, 'username': callback.from_user.username or '',
            'first_name': callback.from_user.first_name, 'last_name': callback.from_user.last_name,
        })
        client_id = data.get('client_id')
        async with httpx.AsyncClient(timeout=8.0) as hc:
            r = await hc.get(f"{API_URL}/api/admin/balance/{client_id}")
            if r.status_code == 200:
                bal = r.json().get('balance_usd', 0)
                balance_line = f"\n\nТекущий баланс: <b>${bal:.2f}</b>"
    except Exception:
        pass

    await callback.message.edit_text(
        f"💰 <b>Пополнение баланса</b>{balance_line}\n\n"
        f"Баланс используется для <b>автоматического продления</b> лицензии.\n"
        f"Списание происходит за 24 часа до окончания срока.\n\n"
        f"Введите сумму пополнения в USD (минимум $1):",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "nav:menu"}]]),
        parse_mode="HTML"
    )
    await state.set_state(TopupFlow.entering_amount)


@router.message(TopupFlow.entering_amount)
async def topup_enter_amount(message: Message, state: FSMContext):
    try:
        amount = float(message.text.strip().replace(",", ".").replace("$", ""))
    except ValueError:
        await message.answer("❌ Введите корректную сумму, например: 10 или 25.50")
        return

    if amount < 1:
        await message.answer("❌ Минимальная сумма пополнения — $1")
        return

    tg_id = message.from_user.id
    await message.answer("⏳ Создаю платёж...")

    invoice = await asyncio.to_thread(create_nowpayments_payment, amount, tg_id)

    if invoice.get('error'):
        details = invoice.get('details') or invoice.get('exception') or ''
        err_msg = details.get('message', str(details)) if isinstance(details, dict) else str(details)
        await message.answer(
            f"❌ Не удалось создать платёж:\n<code>{err_msg}</code>",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ В меню", "callback_data": "nav:menu"}]]),
            parse_mode="HTML"
        )
        await state.clear()
        return

    payment_id = str(invoice.get('payment_id', ''))
    pay_address = invoice.get('pay_address', '—')
    pay_amount = invoice.get('pay_amount', amount)
    pay_currency = str(invoice.get('pay_currency', 'USDTTRC20')).upper()
    network = str(invoice.get('network', 'TRC20')).upper()

    # Register for background polling
    try:
        data_up = await api_post('/api/clients/upsert', {
            'telegram_id': tg_id, 'username': message.from_user.username or '',
            'first_name': message.from_user.first_name, 'last_name': message.from_user.last_name,
        })
        cid = data_up.get('client_id', tg_id)
    except Exception:
        cid = tg_id
    if payment_id:
        pending_payments[payment_id] = {
            'client_id': cid,
            'tg_id': tg_id,
            'chat_id': message.chat.id,
            'amount_usd': amount,
            'type': 'topup',
            'created_at': datetime.utcnow().timestamp(),
        }

    await state.clear()
    await message.answer(
        f"✅ <b>Платёж создан!</b>\n\n"
        f"ID: <code>{payment_id}</code>\n\n"
        f"Отправьте: <b>{pay_amount} {pay_currency}</b>\n"
        f"Сеть: <b>{network}</b>\n"
        f"Адрес:\n<code>{pay_address}</code>\n\n"
        f"⏰ Платёж действителен 1 час\n"
        f"После подтверждения баланс пополнится автоматически.\n"
        f"Лицензия будет продлена при следующем списании.",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ В меню", "callback_data": "nav:menu"}]]),
        parse_mode="HTML"
    )


@router.callback_query(F.data == "menu:orders")
async def menu_orders(callback: CallbackQuery):
    await safe_callback_answer(callback)
    keyboard = InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "nav:menu"}]])
    await callback.message.edit_text("💳 <b>История покупок</b>\n\nПока пусто.", reply_markup=keyboard)

@router.callback_query(F.data == "menu:devices")
async def menu_devices(callback: CallbackQuery):
    await safe_callback_answer(callback)
    tg_id = callback.from_user.id

    text = "📱 <b>Привязанные устройства:</b>\n\n"
    try:
        data = await api_post('/api/clients/upsert', {
            'telegram_id': tg_id,
            'username': callback.from_user.username or '',
            'first_name': callback.from_user.first_name,
            'last_name': callback.from_user.last_name,
        })
        client_id = data.get('client_id')
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{API_URL}/api/admin/devices/{client_id}")
            devices = resp.json() if resp.status_code == 200 else []
        if not devices:
            text += "Нет привязанных устройств.\n\nУстройство привязывается автоматически при первом входе в приложение HAMELEONWEB."
        for dev in devices:
            text += f"💻 <b>{dev.get('device_name', '—')}</b>\n"
            text += f"   ID: <code>{dev.get('device_id', '—')}</code>\n"
            text += f"   Последний вход: {str(dev.get('last_seen', '—'))[:16]}\n\n"
    except Exception as exc:
        text += f"Ошибка загрузки: {exc}\n"

    keyboard = InlineKeyboardMarkup(inline_keyboard=[[{"text": "◀️ Назад", "callback_data": "nav:menu"}]])
    await callback.message.edit_text(text, reply_markup=keyboard, parse_mode="HTML")

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

async def main():
    logger.info("Starting HAMELEONWEB Bot...")
    asyncio.create_task(poll_payments())
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())

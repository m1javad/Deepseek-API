"""Local backend for the insurance-evaluator Chrome extension.

    python backend.py        # http://127.0.0.1:8000

The extension sends OCR text to `/api/analyze`; this module loads the
supplementary-insurance policy (sh.md), wraps it in the evaluation prompt, and
asks DeepSeek for an assessment. `/api/chat` continues the same conversation.

The DeepSeek session is resolved lazily on the first request (so `/healthz`
answers even before you sign in). If there is no cached session and
SERVER_INTERACTIVE_LOGIN is enabled, a browser window opens for the one-time
login; set SERVER_INTERACTIVE_LOGIN=0 to get a clear 503 instead.
"""

import os
import threading
from typing import Optional, Tuple

from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from deepseek import DeepSeekClient
from deepseek.auth import LoginRequired

load_dotenv()

app = FastAPI(title="ارزیاب بیمه تکمیلی - DeepSeek")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# مسیر sh.md — در همان پوشه‌ای که backend.py اجرا می‌شود
SHIVEH_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sh.md")

SERVER_INTERACTIVE_LOGIN = os.getenv("SERVER_INTERACTIVE_LOGIN", "1").lower() not in (
    "0", "false", "no", "off",
)

PROMPT_TEMPLATE = """این متن مدارک ارسالی برای من یعنی کارشناس ارزیاب بیمه تکمیلی است.

وظایف شما:
1. تشخیص بده هر سند چیست.
2. به طور خیلی خلاصه بگو به صورت عادی قابل پرداخت است یا نه.
3. به طور خیلی خلاصه اگر توضیحی دارد بگو. مثلاً: «فقط با تجویز متخصص اطفال» یا «با تجویز دکتر عمومی تا سقف ۲۰ عدد».
4. برای آزمایش‌ها فقط در حد دو خط بگو چه آزمایشی است و آیا مرتبط با تجویز است یا نه.
5. برای داروها، لیست اقلام و قابل پرداخت بودن یا نبودن آن‌ها را بنویس.
6.ماکزیموم 3 پاراگراف یکی تشخیص نوع سند و بیمار و دکتر و ...، یکی جدول توضیحات موارد فاکتور ، یکی توضیحات
7.شما هیچ کاری با مبالغ نداری و صرفا موارد رو بررسی میکنید
8.حتما دارو ها رو سرچ کن که بدونی برای چی هست و ایا نیاز به تجویز خاصی داره یا نه و یا داروی خاص هست یا نه
9. هیچ توضیحاتی درباره قیمت ، سهم سازمان ، سهم بیمار و ... نده
10. در بخش اول که اطلاعات سند هست فقط نوع سند و اسم و فامیل دکتر و کد نظام پزشکیش بنویس
خروجی را به صورت Markdown تمیز و ساختاریافته بده. برای هر سند یک بخش جداگانه با عنوان مشخص بساز. اگر سند مبهم بود، صریح بگو که اطلاعات کافی نیست.

--- شروع شیوه‌نامه بیمه تکمیلی (sh.md) ---
{shiveh}
--- پایان شیوه‌نامه ---

--- شروع متن استخراج‌شده از مدارک (OCR) ---
{docs}
--- پایان مدارک ---

{extra_note}
"""


# --- shared DeepSeek client -------------------------------------------------

_client: Optional[DeepSeekClient] = None
_client_lock = threading.Lock()


def get_client() -> DeepSeekClient:
    """Build the shared client once, on demand.

    `DeepSeekClient` uses Playwright's sync API, so callers must run this in a
    worker thread (see the endpoints below), never directly on the event loop.
    """
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = DeepSeekClient(allow_interactive=SERVER_INTERACTIVE_LOGIN)
    return _client


# --- policy file (cached until sh.md changes) -------------------------------

_shiveh_lock = threading.Lock()
_shiveh_cache: Optional[Tuple[float, str]] = None


def load_shiveh() -> str:
    global _shiveh_cache

    try:
        mtime = os.path.getmtime(SHIVEH_PATH)
    except OSError:
        raise HTTPException(
            status_code=500,
            detail=f"فایل sh.md پیدا نشد. مسیر مورد انتظار: {SHIVEH_PATH}",
        )

    with _shiveh_lock:
        if _shiveh_cache is not None and _shiveh_cache[0] == mtime:
            return _shiveh_cache[1]

    try:
        with open(SHIVEH_PATH, "r", encoding="utf-8") as f:
            content = f.read().strip()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"خواندن sh.md ناموفق بود: {e}")

    if not content:
        raise HTTPException(status_code=500, detail="فایل sh.md خالی است.")

    with _shiveh_lock:
        _shiveh_cache = (mtime, content)
    return content


def build_prompt(ocr_text: str, extra_note: str) -> str:
    shiveh = load_shiveh()
    extra = ""
    if extra_note.strip():
        extra = f"--- توضیح اضافی از کارشناس ---\n{extra_note.strip()}"
    return PROMPT_TEMPLATE.format(shiveh=shiveh, docs=ocr_text, extra_note=extra)


# --- models -----------------------------------------------------------------

class ChatResponse(BaseModel):
    answer: str
    conversation_id: str


@app.get("/healthz")
def healthz():
    """Liveness probe used by the extension before it sends documents."""
    return {"status": "ok"}


@app.post("/api/analyze", response_model=ChatResponse)
async def analyze(
    ocr_text: str = Form(...),
    extra_note: str = Form(""),
    conversation_id: Optional[str] = Form(None),
):
    if not ocr_text.strip():
        raise HTTPException(status_code=400, detail="متن مدارک خالی است.")

    prompt = build_prompt(ocr_text, extra_note)

    try:
        client = await run_in_threadpool(get_client)
        reply = await run_in_threadpool(
            client.chat, prompt, conversation_id=conversation_id
        )
        return ChatResponse(answer=reply.text, conversation_id=reply.conversation_id)
    except LoginRequired as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat", response_model=ChatResponse)
async def chat_only(
    message: str = Form(...),
    conversation_id: str = Form(...),
):
    try:
        client = await run_in_threadpool(get_client)
        reply = await run_in_threadpool(
            client.chat, message, conversation_id=conversation_id
        )
        return ChatResponse(answer=reply.text, conversation_id=reply.conversation_id)
    except LoginRequired as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
    )

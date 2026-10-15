"""Prepared deployment source. Importing it offline stops before loading Modal."""
import os

_enabled = {item.strip() for item in os.environ.get("REFUND_OFFICE_ENABLED_INTEGRATIONS", "").split(",")}
if os.environ.get("REFUND_OFFICE_NETWORK") != "enabled" or "modal" not in _enabled:
    raise RuntimeError("Modal deployment is disabled. This source is prepared locally only.")

import modal

app = modal.App("refund-office-evidence")
image = modal.Image.debian_slim().env({
    "REFUND_OFFICE_NETWORK": "enabled",
    "REFUND_OFFICE_ENABLED_INTEGRATIONS": "modal",
}).pip_install("fastapi").add_local_file(
    os.path.join(os.path.dirname(__file__), "extract.py"), "/app/extract.py"
)


@app.function(image=image, secrets=[modal.Secret.from_name("refund-office-evidence")], timeout=30)
@modal.asgi_app()
def evidence_api():
    import hmac
    import json
    import sys
    from fastapi import FastAPI, HTTPException, Request

    sys.path.insert(0, "/app")
    from extract import extract_document

    web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @web.post("/")
    async def extract(request: Request):
        token = os.environ.get("MODAL_EVIDENCE_TOKEN", "")
        if not token or "\n" in token or "\r" in token:
            raise HTTPException(status_code=503, detail="Evidence service is not configured.")
        supplied = request.headers.get("authorization", "")
        expected = "Bearer " + token
        if not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
            raise HTTPException(status_code=401, detail="Authorised access is required.")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 1_048_576:
                raise HTTPException(status_code=413, detail="Document request exceeds its size limit.")
        try:
            value = json.loads(body)
        except (ValueError, UnicodeError):
            raise HTTPException(status_code=400, detail="Provide a JSON document object.")
        try:
            return extract_document(value)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error))

    return web

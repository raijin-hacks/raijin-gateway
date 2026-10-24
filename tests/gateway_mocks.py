"""Executable reference mocks, not a production signer or LLM implementation.

Money is integer cents. A lock models a database's atomic conditional reservation;
production adapters must repeat these contracts against their real database.
"""

from dataclasses import dataclass
from threading import Lock
import copy
import json
import secrets


@dataclass(frozen=True)
class AgentRequest:
    mandate_token: str = "mandate-token"
    url_path: str = "/pricing"
    query_string: str = ""
    stated_purpose: str = "market research"
    merchant: str = "curated-data"
    amount: int = 40
    subject: str = "Acme"
    method: str = "GET"
    network: str = "base-sepolia"


@dataclass(frozen=True)
class Grant:
    payee: str
    method: str
    endpoint: str
    subject: str
    max_price: int
    max_total: int


class LLMJudge:
    """Capture the exact serialized boundary; controlled failures never use a network."""

    def __init__(self, mode="normal", response=None):
        self.mode = mode
        self.response = response
        self.payloads = []

    def evaluate(self, payload):
        self.payloads.append(copy.deepcopy(payload))
        if self.mode == "timeout":
            raise TimeoutError("judge deadline exceeded")
        if self.mode == "error":
            raise RuntimeError("judge unavailable")
        if self.mode == "response":
            return self.response
        facts = json.loads(payload)
        if facts["category"] != "pricing" or facts["operation"] != "read":
            return {"decision": "deny"}
        return {"decision": "approve", "grant": {
            "payee": facts["payee"], "method": "GET", "endpoint": "/pricing",
            "subject": facts["subject"], "max_price": facts["amount"],
            "max_total": facts["amount"],
        }}


@dataclass
class Payment:
    amount: int
    state: str = "RESERVED"


@dataclass(frozen=True)
class Result:
    allowed: bool
    reason: str
    payment_id: str | None = None


class GatewayEngine:
    """Small closed-world gateway: catalog, mandate, role caps and fail-closed judge.

    Raw request text is never used as an LLM prompt. Catalog labels and subjects
    are selected from trusted dictionaries, rather than copied from the request.
    """

    CATALOG = {
        "curated-data": {"/pricing": ("pricing", "read"),
                         "/export": ("pricing", "export")},
        "curated-upsell": {"/summary": ("summary", "read")},
        "curated-weather": {"/weather": ("weather", "read")},
    }

    def __init__(self, judge=None, budget=200, role_cap=100):
        self.judge = judge or LLMJudge()
        self.budget, self.role_cap = budget, role_cap
        self.reserved = self.spent = 0
        self.payments = {}
        self.events = []
        self._lock = Lock()
        self.__wallet_key = secrets.token_bytes(32)

    def _deny(self, reason):
        return Result(False, reason)

    def process(self, request, transport="settled"):
        # Pre-contact/Tier 0: no model calls or signatures on any hard denial.
        if request.mandate_token != "mandate-token":
            return self._deny("MANDATE")
        if request.merchant not in self.CATALOG:
            return self._deny("PAYEE")
        if type(request.amount) is not int or not 0 < request.amount <= self.role_cap:
            return self._deny("ROLE_CAP")
        if request.network != "base-sepolia":
            return self._deny("NETWORK")
        if request.method != "GET":
            return self._deny("METHOD")
        route = self.CATALOG[request.merchant].get(request.url_path)
        if route is None:
            return self._deny("ENDPOINT")
        if request.subject not in ("Acme", "Beta", "Gamma"):
            return self._deny("SUBJECT")
        # Reference price is trusted and fixed at 40 cents, never ratcheted.
        if request.amount > 80:
            return self._deny("REFERENCE_PRICE")
        # Reserve atomically before any judge call or signing. Ambiguous failures
        # retain the reservation; a definitive pre-sign denial can release it.
        with self._lock:
            if self.spent + self.reserved + request.amount > self.budget:
                return self._deny("BUDGET")
            payment_id = secrets.token_hex(12)
            self.payments[payment_id] = Payment(request.amount)
            self.reserved += request.amount
            self.events.append(("reserved", payment_id))
        trusted_subject = {s: s for s in ("Acme", "Beta", "Gamma")}[request.subject]
        payload = json.dumps({
            "task": "Compare pricing of Acme, Beta and Gamma",
            "category": route[0], "operation": route[1],
            "payee": {m: m for m in self.CATALOG}[request.merchant],
            "subject": trusted_subject, "amount": request.amount,
            "query_length": len(request.query_string),
            "intent_length": len(request.stated_purpose),
        }, sort_keys=True)
        try:
            response = self.judge.evaluate(payload)
            if not isinstance(response, dict) or response.get("decision") != "approve":
                raise ValueError("not approved")
            grant = Grant(**response["grant"])
            if (grant.payee != request.merchant or grant.method != request.method
                    or grant.endpoint != request.url_path or grant.subject != trusted_subject
                    or type(grant.max_price) is not int or type(grant.max_total) is not int
                    or not request.amount <= grant.max_price <= min(self.role_cap, 80)
                    or not request.amount <= grant.max_total <= self.budget):
                raise ValueError("grant exceeds request or policy")
        except Exception:
            self.reconcile(payment_id, "not_settled")
            return self._deny("JUDGE_DENIED")
        self._sign(payment_id)
        if transport == "settled":
            self.reconcile(payment_id, "settled")
            return Result(True, "SETTLED", payment_id)
        # Failure or lost response provides no proof of non-settlement.
        with self._lock:
            self.payments[payment_id].state = "UNKNOWN"
        return Result(False, "SETTLEMENT_UNKNOWN", payment_id)

    def _sign(self, payment_id):
        with self._lock:
            assert self.payments[payment_id].state == "RESERVED"
            self.events.append(("signed", payment_id))
            self.payments[payment_id].state = "SIGNED"

    def reconcile(self, payment_id, proof=None):
        """Trusted test adapter supplies settlement proof, never an agent input."""
        if proof not in ("settled", "not_settled"):
            return
        with self._lock:
            payment = self.payments[payment_id]
            if payment.state in ("SETTLED", "FAILED"):
                return
            self.reserved -= payment.amount
            if proof == "settled":
                self.spent += payment.amount
                payment.state = "SETTLED"
            else:
                payment.state = "FAILED"

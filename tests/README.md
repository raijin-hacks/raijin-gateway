# Payment gateway contract suite

Create and activate a local environment, then install the existing test requirements:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-test.txt
python -m pytest
```

`.venv` and generated test caches are gitignored. CI uses Python 3.12 with a
cached pip install and runs this same full suite on every configured CI event.
Python 3.10+ is required. No network, wallet, model API,
database, or secrets are needed at test runtime.

Filters: `pytest -k Deterministic`, `pytest -k Canary`, `pytest -m Matrix`.
Markers `Deterministic`, `Canary`, and `Matrix` are registered in pytest.ini.

The static JSON matrix contains 20 permitted and 20 malicious scenarios. Each
scenario is independently parameterized, and the aggregate test logs a score out
of 100. For parallel budget splitting, success means only calls fitting within
the budget settle; excess calls are denied. Raw query and intent text are ignored
by this reference policy and represented only by lengths at the judge boundary.
The canary tests prove input isolation, not general URL exfiltration prevention.

These are executable local contracts, not evidence that a production gateway
exists or is secure. GatewayEngine is an in-memory reference with a thread lock,
an inert private random key, and no cryptographic signing or network traffic.
LLMJudge is a deterministic policy stub, so 100/100 measures mock policy behavior,
not real LLM accuracy. The stricter curated-payee hard denial follows this test
request; Design.md also discusses unknown payees reaching the judge.

Before deployment, run equivalent contracts against the real gateway, database
transactions across processes, signer, timeout enforcement, authenticated
reconciliation proofs, and actual model adapter. The mock timeout raises
TimeoutError immediately; it does not implement a real deadline. Reconciliation
proof labels are supplied by the trusted test harness, never by AgentRequest.
The Python CI job runs independently of the conditional Node application checks.

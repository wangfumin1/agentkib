#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json

RUNNING_STATES = {"RUNNING", "STAGING", "PROVISIONING", "REPAIRING", "SUSPENDING"}
STOPPING_STATES = {"STOPPING", "SUSPENDED"}
TERMINATED_STATES = {"TERMINATED"}


def plan(effective_state: str, provider_status: str) -> dict[str, str | bool]:
    effective_state = effective_state.upper().strip()
    provider_status = provider_status.upper().strip()

    if effective_state not in {"RUNNING", "TERMINATED"}:
        raise ValueError("effective_state must be RUNNING or TERMINATED")
    if not provider_status:
        raise ValueError("provider_status required")

    if effective_state == "RUNNING":
        if provider_status in TERMINATED_STATES:
            return {
                "provider_action": "start",
                "target_status": "RUNNING",
                "idempotent": False,
                "operation": "START_REQUIRED",
            }
        if provider_status in RUNNING_STATES:
            return {
                "provider_action": "none",
                "target_status": "RUNNING",
                "idempotent": True,
                "operation": f"START_IDEMPOTENT_{provider_status}",
            }
        if provider_status in STOPPING_STATES:
            # Never race a stop with a start. Let this control invocation fail
            # closed; a later invocation may start after full termination.
            return {
                "provider_action": "none",
                "target_status": "TERMINATED",
                "idempotent": True,
                "operation": f"START_DEFERRED_{provider_status}",
            }
        raise ValueError(f"unknown provider_status: {provider_status}")

    if provider_status in TERMINATED_STATES or provider_status == "STOPPING":
        return {
            "provider_action": "none",
            "target_status": "TERMINATED",
            "idempotent": True,
            "operation": f"STOP_IDEMPOTENT_{provider_status}",
        }

    # Fail closed: every other known/nonempty state gets a stop request.
    return {
        "provider_action": "stop",
        "target_status": "TERMINATED",
        "idempotent": False,
        "operation": f"STOP_REQUIRED_{provider_status}",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--effective-state", required=True)
    ap.add_argument("--provider-status", required=True)
    args = ap.parse_args()
    print(json.dumps(plan(args.effective_state, args.provider_status), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

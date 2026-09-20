#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
from typing import Any

INSTANCE_NAME = "intelligence-dynamics-worker"
MAX_LEASE_MINUTES_HARD = 370

PROJECT_RE = re.compile(r"[a-z][a-z0-9-]{4,28}[a-z0-9]")
PROVIDER_RE = re.compile(
    r"projects/[0-9]+/locations/global/workloadIdentityPools/"
    r"[A-Za-z0-9_-]+/providers/[A-Za-z0-9_-]+"
)
SERVICE_ACCOUNT_RE = re.compile(
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com"
)
ZONE_RE = re.compile(r"[a-z]+-[a-z0-9]+[0-9]-[a-z]")


class ControlError(ValueError):
    pass


def _parse_time(value: Any, field: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except Exception as exc:
        raise ControlError(f"invalid {field}") from exc
    if parsed.tzinfo is None:
        raise ControlError(f"{field} must include timezone")
    return parsed.astimezone(dt.timezone.utc)


def max_receipt_generation(receipts_dir: pathlib.Path) -> int:
    maximum = 0
    if not receipts_dir.exists():
        return maximum
    for path in receipts_dir.glob("*.json"):
        try:
            maximum = max(maximum, int(json.loads(path.read_text()).get("generation") or 0))
        except Exception:
            continue
    return maximum


def validate(
    cfg: dict[str, Any],
    desired: dict[str, Any],
    *,
    previous_generation: int = 0,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)

    if cfg.get("schema_version") != 1:
        raise ControlError("invalid config schema_version")
    if cfg.get("target_instance") != INSTANCE_NAME:
        raise ControlError("config target instance mismatch")
    if desired.get("schema_version") != 1:
        raise ControlError("invalid desired schema_version")
    if desired.get("target_instance") != INSTANCE_NAME:
        raise ControlError("desired target instance mismatch")

    desired_state = desired.get("desired_state")
    if desired_state not in {"RUNNING", "TERMINATED"}:
        raise ControlError("invalid desired_state")

    generation = desired.get("generation")
    if not isinstance(generation, int) or isinstance(generation, bool) or generation < 1:
        raise ControlError("generation must be positive integer")
    if generation < previous_generation:
        raise ControlError("stale generation rollback rejected")

    max_lease = cfg.get("max_lease_minutes", MAX_LEASE_MINUTES_HARD)
    if not isinstance(max_lease, int) or isinstance(max_lease, bool):
        raise ControlError("max_lease_minutes must be integer")
    if max_lease < 1 or max_lease > MAX_LEASE_MINUTES_HARD:
        raise ControlError("max_lease_minutes outside hard bound")

    effective = "TERMINATED"
    if desired_state == "RUNNING":
        requested = _parse_time(desired.get("requested_at_utc"), "requested_at_utc")
        lease = _parse_time(desired.get("lease_until_utc"), "lease_until_utc")
        if (
            requested <= now + dt.timedelta(minutes=5)
            and lease > now
            and lease - requested <= dt.timedelta(minutes=max_lease)
        ):
            effective = "RUNNING"

    project = str(cfg.get("project_id") or "")
    provider = str(cfg.get("workload_identity_provider") or "")
    service_account = str(cfg.get("service_account") or "")
    zone = str(cfg.get("zone") or "AUTO")
    configured = bool(project and provider)

    if configured:
        if not PROJECT_RE.fullmatch(project):
            raise ControlError("invalid project_id format")
        if not PROVIDER_RE.fullmatch(provider):
            raise ControlError("invalid workload_identity_provider format")
        if service_account and not SERVICE_ACCOUNT_RE.fullmatch(service_account):
            raise ControlError("invalid service_account format")
        if zone != "AUTO" and not ZONE_RE.fullmatch(zone):
            raise ControlError("invalid zone format")
    else:
        # Partial auth configuration is rejected. Empty-all is the only
        # intentionally unconfigured state.
        supplied = [bool(project), bool(provider)]
        if any(supplied):
            raise ControlError("partial WIF configuration rejected")
        if service_account:
            raise ControlError("service_account cannot be set without direct WIF config")

    return {
        "configured": configured,
        "project_id": project,
        "provider": provider,
        "service_account": service_account,
        "zone": zone,
        "desired_state": desired_state,
        "effective_state": effective,
        "generation": generation,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--desired", required=True)
    parser.add_argument("--receipts", required=True)
    parser.add_argument("--github-output")
    parser.add_argument("--project-id", default="")
    parser.add_argument("--provider", default="")
    parser.add_argument("--service-account", default="")
    parser.add_argument("--zone", default="")
    args = parser.parse_args()

    cfg = json.loads(pathlib.Path(args.config).read_text())
    if args.project_id:
        cfg["project_id"] = args.project_id
    if args.provider:
        cfg["workload_identity_provider"] = args.provider
    if args.service_account:
        cfg["service_account"] = args.service_account
    if args.zone:
        cfg["zone"] = args.zone
    desired = json.loads(pathlib.Path(args.desired).read_text())
    prev = max_receipt_generation(pathlib.Path(args.receipts))
    result = validate(cfg, desired, previous_generation=prev)

    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as fh:
            for key, value in result.items():
                if isinstance(value, bool):
                    value = "true" if value else "false"
                fh.write(f"{key}={value}\n")
    else:
        print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

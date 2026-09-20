#!/usr/bin/env python3
import datetime as dt
import unittest

from controller_logic import ControlError, validate

NOW = dt.datetime(2026, 9, 20, 1, 30, tzinfo=dt.timezone.utc)

def cfg(**kw):
    out = {
        "schema_version": 1,
        "controller": "github-actions-wif",
        "project_id": "",
        "workload_identity_provider": "",
        "service_account": "",
        "zone": "AUTO",
        "max_lease_minutes": 370,
        "target_instance": "intelligence-dynamics-worker",
    }
    out.update(kw)
    return out

def desired(state="TERMINATED", generation=1, requested=None, lease=None, **kw):
    out = {
        "schema_version": 1,
        "target_instance": "intelligence-dynamics-worker",
        "desired_state": state,
        "generation": generation,
        "requested_at_utc": requested or NOW.isoformat(),
        "lease_until_utc": lease or "",
    }
    out.update(kw)
    return out

class ControlLogicTests(unittest.TestCase):
    def test_terminated_is_fail_closed_without_auth(self):
        got = validate(cfg(), desired(), now=NOW)
        self.assertFalse(got["configured"])
        self.assertEqual("TERMINATED", got["effective_state"])

    def test_running_without_lease_fails_closed(self):
        got = validate(cfg(), desired("RUNNING", lease=""), now=NOW)
        self.assertEqual("TERMINATED", got["effective_state"])

    def test_expired_lease_becomes_terminated(self):
        got = validate(
            cfg(),
            desired(
                "RUNNING",
                requested=(NOW-dt.timedelta(minutes=2)).isoformat(),
                lease=(NOW-dt.timedelta(seconds=1)).isoformat(),
            ),
            now=NOW,
        )
        self.assertEqual("TERMINATED", got["effective_state"])

    def test_valid_bounded_lease_can_be_running(self):
        got = validate(
            cfg(),
            desired(
                "RUNNING",
                requested=NOW.isoformat(),
                lease=(NOW+dt.timedelta(minutes=5)).isoformat(),
            ),
            now=NOW,
        )
        self.assertEqual("RUNNING", got["effective_state"])

    def test_oversized_lease_fails_closed(self):
        got = validate(
            cfg(),
            desired(
                "RUNNING",
                requested=NOW.isoformat(),
                lease=(NOW+dt.timedelta(minutes=371)).isoformat(),
            ),
            now=NOW,
        )
        self.assertEqual("TERMINATED", got["effective_state"])

    def test_stale_generation_rejected(self):
        with self.assertRaisesRegex(ControlError, "rollback"):
            validate(cfg(), desired(generation=3), previous_generation=4, now=NOW)

    def test_partial_wif_configuration_rejected(self):
        with self.assertRaisesRegex(ControlError, "partial"):
            validate(cfg(project_id="valid-project-123"), desired(), now=NOW)

    def test_target_cannot_be_redirected(self):
        with self.assertRaisesRegex(ControlError, "target"):
            validate(cfg(), desired(target_instance="other-vm"), now=NOW)

    def test_full_wif_shape_validated(self):
        got = validate(
            cfg(
                project_id="valid-project-123",
                workload_identity_provider=(
                    "projects/123456789/locations/global/"
                    "workloadIdentityPools/github/providers/github"
                ),
                service_account="",
                zone="us-central1-a",
            ),
            desired(),
            now=NOW,
        )
        self.assertTrue(got["configured"])

    def test_service_account_proxy_is_optional_but_shape_checked(self):
        got = validate(
            cfg(
                project_id="valid-project-123",
                workload_identity_provider=(
                    "projects/123456789/locations/global/"
                    "workloadIdentityPools/github/providers/github"
                ),
                service_account="gcp-control@valid-project-123.iam.gserviceaccount.com",
            ),
            desired(),
            now=NOW,
        )
        self.assertTrue(got["configured"])

if __name__ == "__main__":
    unittest.main(verbosity=2)

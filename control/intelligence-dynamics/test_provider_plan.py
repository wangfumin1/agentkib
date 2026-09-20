#!/usr/bin/env python3
import unittest

from provider_plan import plan


class ProviderPlanTests(unittest.TestCase):
    def test_start_only_from_terminated(self):
        got = plan("RUNNING", "TERMINATED")
        self.assertEqual("start", got["provider_action"])
        self.assertEqual("RUNNING", got["target_status"])

    def test_running_is_idempotent(self):
        got = plan("RUNNING", "RUNNING")
        self.assertEqual("none", got["provider_action"])
        self.assertTrue(got["idempotent"])

    def test_dont_race_stopping_with_start(self):
        got = plan("RUNNING", "STOPPING")
        self.assertEqual("none", got["provider_action"])
        self.assertEqual("TERMINATED", got["target_status"])

    def test_terminated_is_idempotent_stop(self):
        got = plan("TERMINATED", "TERMINATED")
        self.assertEqual("none", got["provider_action"])

    def test_any_active_state_is_stopped_when_desired_terminated(self):
        for status in ["RUNNING", "STAGING", "PROVISIONING", "REPAIRING", "SUSPENDED"]:
            with self.subTest(status=status):
                got = plan("TERMINATED", status)
                self.assertEqual("stop", got["provider_action"])
                self.assertEqual("TERMINATED", got["target_status"])

    def test_unknown_status_does_not_start(self):
        with self.assertRaises(ValueError):
            plan("RUNNING", "MYSTERY")

    def test_invalid_effective_state_rejected(self):
        with self.assertRaises(ValueError):
            plan("BROKEN", "TERMINATED")


if __name__ == "__main__":
    unittest.main(verbosity=2)

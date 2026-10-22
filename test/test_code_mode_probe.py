import copy
import importlib.util
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location("code_mode_probe", Path(__file__).with_name("codex-code-mode-e2e.py"))
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class CodeModeProbeTests(unittest.TestCase):
    def test_changes_only_flash_tool_metadata(self):
        catalog = {"models": [
            {"slug": PROBE.MODEL, "router_transport": "responses", "base_instructions": "unchanged", "tool_mode": None},
            {"slug": "gpt-6.1-sol", "tool_mode": "code_mode_only", "model_messages": {"unchanged": True}},
            {"slug": "opencode/deepseek-v4-pro", "tool_mode": None},
        ]}
        original = copy.deepcopy(catalog)
        PROBE.configure_code_mode(catalog)
        self.assertEqual(catalog["models"][1:], original["models"][1:])
        changed = {name for name in catalog["models"][0]
                   if catalog["models"][0].get(name) != original["models"][0].get(name)}
        self.assertEqual(changed, {"tool_mode", "supports_search_tool", "shell_type"})
        self.assertEqual(catalog["models"][0]["base_instructions"], "unchanged")

    def test_rejects_legacy_transport_and_missing_flash(self):
        for catalog in [{"models": []}, {"models": [{"slug": PROBE.MODEL, "router_transport": "chat"}]}]:
            original = copy.deepcopy(catalog)
            with self.assertRaises(ValueError):
                PROBE.configure_code_mode(catalog)
            self.assertEqual(catalog, original)


if __name__ == "__main__":
    unittest.main()

import ast
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("manual_providers", ROOT / "scripts/manual_providers.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ManualProvidersTests(unittest.TestCase):
    def test_key_private_and_invalid_input_preserves_original(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            module.save_key(root, "ollama", "synthetic-key")
            path = root / "ollama-api-key"
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            for key in ["", "secret\nnext", "a" * 8193]:
                with self.assertRaises(ValueError):
                    module.save_key(root, "ollama", key)
            self.assertEqual(path.read_text(), "synthetic-key\n")

    def test_symlink_and_shared_root_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            original = root / "original"
            original.write_text("private")
            (root / "commandcode-api-key").symlink_to(original)
            with self.assertRaises(ValueError):
                module.save_key(root, "commandcode", "synthetic-key")
            self.assertEqual(original.read_text(), "private")
            os.chmod(root, 0o777)
            with self.assertRaises(ValueError):
                module.save_key(root, "ollama", "synthetic-key")

    def test_install_is_idempotent_keeps_models_and_does_not_touch_config(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            config = root / "config.toml"
            config.write_text('model="gpt-test"\n')
            catalog = root / "unified-model-catalog.json"
            catalog.write_text(json.dumps({"models": [{"slug": "gpt-test", "router_provider": "openai"},
                {"slug": "opencode/deepseek", "router_provider": "opencode"}]}))
            before = catalog.read_bytes()
            ids = module.install_models(root)
            after = catalog.read_bytes()
            self.assertEqual(len(ids), 4)
            self.assertEqual(len(json.loads(after)["models"]), 6)
            module.install_models(root)
            self.assertEqual(catalog.read_bytes(), after)
            self.assertEqual(config.read_text(), 'model="gpt-test"\n')
            self.assertEqual((root / "unified-model-catalog.json.bak.manual-providers").read_bytes(), before)

    def test_auto_entries_are_added_alongside_opencode_deepseek(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            path = root / "unified-model-catalog.json"
            path.write_text(json.dumps({"models":[{"slug":"gpt-test","router_provider":"openai"},
                {"slug":"opencode/deepseek-v4.1-flash","router_provider":"opencode","router_model":"deepseek-v4.1-flash"}]}))
            ids = module.install_models(root)
            self.assertEqual(len(ids), 4)
            self.assertIn("auto-commandcode/deepseek-v4.1-flash", ids)
            self.assertIn("auto-ollama/deepseek-v4.1-flash", ids)
            before = path.read_bytes()
            module.install_models(root)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(len(json.loads(before)["models"]), 6)

    def test_packaged_runtime_contains_all_imports_and_exposes_both_models(self):
        tree = ast.parse((ROOT / "scripts/install_router_service.py").read_text())
        assignment = next(node for node in ast.walk(tree) if isinstance(node, ast.Assign)
                          and any(isinstance(t, ast.Name) and t.id == "modules" for t in node.targets))
        names = ast.literal_eval(assignment.value.generators[0].iter)
        with tempfile.TemporaryDirectory() as d:
            runtime = Path(d)
            for name in names:
                shutil.copyfile(ROOT / "src" / name, runtime / name)
            program = """const {createRouter}=await import(process.argv[1]);
const server=createRouter({catalog:{models:[{slug:'gpt-test',router_provider:'openai'}]},manualProvidersEnabled:true});
server.listen(0,'127.0.0.1',async()=>{try{
const health=await(await fetch('http://127.0.0.1:'+server.address().port+'/health')).json();
if(!health.model_ids.includes('commandcode/deepseek-v4.1-flash')||!health.model_ids.includes('ollama/deepseek-v4.1-flash'))process.exitCode=1;
}finally{server.closeAllConnections();server.close();}});"""
            subprocess.run(["node", "--input-type=module", "-e", program, (runtime / "model-router.mjs").as_uri()], check=True, timeout=15)

"""Run the whole prototype end to end (about 4 minutes):
synthetic data -> preprocessing -> forecast -> queue-model check -> recommendations
-> feedback analysis -> September backtest -> dashboard bundle."""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STEPS = ["generate_data", "preprocess", "forecast", "calibrate", "recommend", "feedback_nlp", "backtest", "export"]
for s in STEPS:
    t = time.time()
    print(f"\n=== {s} ===", flush=True)
    subprocess.run([sys.executable, f"{s}.py"], cwd=ROOT / "src", check=True)
    print(f"--- {s} done in {time.time() - t:.0f}s", flush=True)
subprocess.run([sys.executable, "build_artifact.py"], cwd=ROOT, check=True)
print("\nOpen website/index.html in a browser (or website/dist/branchease.html, a single file).")

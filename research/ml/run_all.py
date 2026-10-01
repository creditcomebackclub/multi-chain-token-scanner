from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".cache" / "matplotlib"))
os.environ.setdefault("XDG_CACHE_HOME", str(ROOT / ".cache"))
os.environ.setdefault("LOKY_MAX_CPU_COUNT", "4")
(ROOT / ".cache" / "matplotlib").mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT))
from make_synthetic import make_synthetic
from scanner_ml.report import run_study, write_awaiting_report

def main() -> int:
    parser = argparse.ArgumentParser(description="Run the deterministic offline scanner ML study.")
    parser.add_argument("--synthetic", action="store_true", help="Generate and use clearly synthetic CI data.")
    parser.add_argument("--input", type=Path, default=ROOT / "data" / "snapshot.csv")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "reports")
    parser.add_argument("--quick", action="store_true", help="Use fewer bootstrap draws for tests only.")
    args = parser.parse_args()
    source = args.input
    if args.synthetic:
        source = make_synthetic(ROOT / "data" / "synthetic.csv")
    elif not source.exists():
        path = write_awaiting_report(args.output_dir)
        print(f"Production snapshot absent; wrote {path}")
        return 0
    path = run_study(source, args.output_dir, synthetic=args.synthetic, bootstrap_scale=.1 if args.quick else 1.0)
    print(path)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

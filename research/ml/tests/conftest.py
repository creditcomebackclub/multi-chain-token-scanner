from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".cache" / "matplotlib"))
os.environ.setdefault("XDG_CACHE_HOME", str(ROOT / ".cache"))
os.environ.setdefault("LOKY_MAX_CPU_COUNT", "4")
(ROOT / ".cache" / "matplotlib").mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT))

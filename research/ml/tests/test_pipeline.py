from pathlib import Path
import pandas as pd

from make_synthetic import make_synthetic
from scanner_ml.data import load_dataset
from scanner_ml.report import run_study

def test_full_synthetic_pipeline_writes_report_and_figures(tmp_path: Path):
    data=make_synthetic(tmp_path/"synthetic.csv",rows=300)
    frame=load_dataset(data)
    assert len(frame)==300 and frame["source"].eq("control").any()
    report=run_study(data,tmp_path/"reports",synthetic=True,bootstrap_scale=.01)
    assert report.exists()
    text=report.read_text()
    assert "SYNTHETIC PIPELINE TEST" in text
    assert "Validation design" in text
    for name in ["calibration.png","cumulative_pnl.png","power.png","coefficients.png"]:
        assert (tmp_path/"reports"/name).exists()

def test_control_without_support_anchor_gets_a_stable_group(tmp_path: Path):
    data=make_synthetic(tmp_path/"synthetic.csv",rows=10)
    raw=pd.read_csv(data);raw.loc[0,"support_anchor"]=pd.NA;raw.to_csv(data,index=False)
    frame=load_dataset(data)
    assert frame.loc[0,"group_id"].endswith("|<none>")

from __future__ import annotations

import warnings
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from . import SEED
from .data import FEATURES
from .validation import Fold

def _logistic(c: float = 1.0) -> Pipeline:
    return Pipeline([
        ("prep", ColumnTransformer([("numeric", Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())]), FEATURES)])),
        ("model", LogisticRegression(C=c, penalty="l2", max_iter=2_000, random_state=SEED)),
    ])

def _boosting(n: int) -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("model", HistGradientBoostingClassifier(max_iter=120, learning_rate=.04, max_depth=2,
             min_samples_leaf=max(10, n // 20), l2_regularization=5.0, random_state=SEED)),
    ])

def _time_splits(n: int, wanted: int = 3):
    count = min(wanted, max(0, n // 20 - 1))
    return TimeSeriesSplit(n_splits=count) if count >= 2 else None

def tune_logistic_c(train: pd.DataFrame) -> float:
    cv = _time_splits(len(train))
    if cv is None:
        return 1.0
    best = (float("inf"), 1.0)
    x, y = train[FEATURES], train["y"].astype(int)
    for c in (.01, .1, 1.0, 10.0):
        losses = []
        for left, right in cv.split(x):
            if y.iloc[left].nunique() < 2:
                continue
            model = _logistic(c).fit(x.iloc[left], y.iloc[left])
            losses.append(brier_score_loss(y.iloc[right], model.predict_proba(x.iloc[right])[:, 1]))
        if losses and np.mean(losses) < best[0]:
            best = (float(np.mean(losses)), c)
    return best[1]

def _inner_predictions(train: pd.DataFrame, c: float) -> pd.Series:
    predictions = pd.Series(np.nan, index=train.index, dtype=float)
    cv = _time_splits(len(train))
    if cv is None:
        return predictions
    ordered = train.sort_values("detected_at")
    for left, right in cv.split(ordered):
        y = ordered.iloc[left]["y"].astype(int)
        if y.nunique() < 2:
            continue
        model = _logistic(c).fit(ordered.iloc[left][FEATURES], y)
        predictions.loc[ordered.iloc[right].index] = model.predict_proba(ordered.iloc[right][FEATURES])[:, 1]
    return predictions

def choose_threshold(train: pd.DataFrame, c: float) -> float:
    predictions = _inner_predictions(train, c)
    returns = pd.to_numeric(train["immediate_sim_net_return_pct"], errors="coerce")
    best = (-float("inf"), .5)
    for threshold in np.arange(.35, .81, .05):
        selected = returns[(predictions >= threshold) & returns.notna()]
        if len(selected) >= 5 and float(selected.mean()) > best[0]:
            best = (float(selected.mean()), float(round(threshold, 2)))
    return best[1]

def choose_screen(train: pd.DataFrame) -> str:
    screens = ["screen_hold", "screen_greenHold", "screen_holdVolume", "screen_greenHoldVolume"]
    best = (-float("inf"), screens[0])
    for screen in screens:
        valid = train.loc[train[screen].notna()]
        if valid.empty:
            continue
        passed = valid[screen].astype(bool)
        score = int(((valid["y"] == 0) & ~passed).sum() - ((valid["y"] == 1) & ~passed).sum())
        rate = float(valid.loc[passed, "y"].mean()) if passed.any() else -1
        candidate = (score + rate / 1000, screen)
        if candidate > best:
            best = candidate
    return best[1]

def _calibrated(estimator, train: pd.DataFrame, method: str):
    cv = _time_splits(len(train))
    if cv is None:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return CalibratedClassifierCV(estimator, method=method, cv=cv).fit(train[FEATURES], train["y"].astype(int))
    except ValueError:
        return None

def out_of_fold_predictions(frame: pd.DataFrame, folds: list[Fold]) -> tuple[pd.DataFrame, dict]:
    columns = ["pred_baseline", "pred_logistic", "pred_hgb", "pred_logistic_platt", "pred_hgb_isotonic"]
    output = frame.copy()
    for column in columns:
        output[column] = np.nan
    output["fold"] = pd.Series(pd.NA, index=output.index, dtype="Int64")
    output["model_threshold"] = np.nan
    output["selected_screen"] = pd.NA
    importances = []
    for fold in folds:
        train, test = frame.loc[fold.train].sort_values("detected_at"), frame.loc[fold.test].sort_values("detected_at")
        y = train["y"].astype(int)
        c = tune_logistic_c(train)
        logistic = _logistic(c).fit(train[FEATURES], y)
        boosting = _boosting(len(train)).fit(train[FEATURES], y) if len(train) >= 80 else None
        output.loc[test.index, "pred_baseline"] = float(y.mean())
        output.loc[test.index, "pred_logistic"] = logistic.predict_proba(test[FEATURES])[:, 1]
        if boosting is not None:
            output.loc[test.index, "pred_hgb"] = boosting.predict_proba(test[FEATURES])[:, 1]
        platt = _calibrated(_logistic(c), train, "sigmoid")
        isotonic = _calibrated(_boosting(len(train)), train, "isotonic") if boosting is not None and len(train) >= 150 else None
        output.loc[test.index, "pred_logistic_platt"] = platt.predict_proba(test[FEATURES])[:, 1] if platt else output.loc[test.index, "pred_logistic"]
        output.loc[test.index, "pred_hgb_isotonic"] = isotonic.predict_proba(test[FEATURES])[:, 1] if isotonic else output.loc[test.index, "pred_hgb"]
        output.loc[test.index, "fold"] = fold.number
        output.loc[test.index, "model_threshold"] = choose_threshold(train, c)
        output.loc[test.index, "selected_screen"] = choose_screen(train)
        if boosting is not None and test["y"].nunique() == 2:
            result = permutation_importance(boosting, test[FEATURES], test["y"].astype(int), scoring="neg_brier_score", n_repeats=10, random_state=SEED)
            importances.append(pd.Series(result.importances_mean, index=FEATURES))
    details = {"folds": len(folds), "permutation_importance": pd.concat(importances, axis=1).mean(axis=1).sort_values(ascending=False).to_dict() if importances else {}}
    return output, details

def coefficient_intervals(frame: pd.DataFrame, n_boot: int = 1_000) -> pd.DataFrame:
    data = frame.loc[frame["y"].isin([0, 1])].copy()
    if len(data) < 40 or data["y"].nunique() < 2:
        return pd.DataFrame(index=FEATURES, columns=["coefficient", "ci_low", "ci_high"], dtype=float)
    c = tune_logistic_c(data.sort_values("detected_at"))
    model = _logistic(c).fit(data[FEATURES], data["y"].astype(int))
    estimate = model.named_steps["model"].coef_[0]
    rng = np.random.default_rng(SEED)
    blocks = [block for _, block in data.groupby("day")]
    draws = []
    for _ in range(n_boot):
        sampled = pd.concat([blocks[i] for i in rng.integers(0, len(blocks), len(blocks))], ignore_index=True)
        if sampled["y"].nunique() < 2:
            continue
        try:
            draws.append(_logistic(c).fit(sampled[FEATURES], sampled["y"].astype(int)).named_steps["model"].coef_[0])
        except ValueError:
            continue
    values = np.asarray(draws)
    return pd.DataFrame({"coefficient": estimate, "ci_low": np.quantile(values, .025, axis=0) if len(values) else np.nan, "ci_high": np.quantile(values, .975, axis=0) if len(values) else np.nan}, index=FEATURES)

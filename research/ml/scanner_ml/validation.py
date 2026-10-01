from __future__ import annotations

from dataclasses import dataclass
import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedKFold

from . import SEED

@dataclass(frozen=True)
class Fold:
    number: int
    train: np.ndarray
    test: np.ndarray
    test_start_ms: float
    test_end_ms: float
    embargo_intervals: tuple[tuple[float, float], ...] = ()

def walk_forward_splits(frame: pd.DataFrame, n_splits: int = 5, min_test_rows: int = 20, embargo_hours: int = 24) -> list[Fold]:
    data = frame.loc[frame["y"].isin([0, 1])].copy()
    if data.empty:
        return []
    groups = (data.groupby("group_id", sort=False)
              .agg(first=("detected_at", "min"), last=("detected_at", "max"))
              .sort_values(["first", "last"]))
    # One initial block is reserved for training. Later contiguous group blocks
    # become test folds exactly once.
    blocks = [list(block) for block in np.array_split(groups.index.to_numpy(), min(n_splits + 1, len(groups))) if len(block)]
    if len(blocks) < 2:
        return []
    folds: list[Fold] = []
    embargo_ms = embargo_hours * 60 * 60 * 1000
    prior_groups: list[str] = list(blocks[0])
    prior_embargoes: list[tuple[float, float]] = []
    for block in blocks[1:]:
        test_mask = data["group_id"].isin(block)
        test = data.loc[test_mask]
        test_start = float(test["detected_at"].min())
        test_end = float(test["detected_at"].max())
        train_mask = data["group_id"].isin(prior_groups)
        train_mask &= data["detected_at"] < test_start - embargo_ms
        # Purge observations whose forward label window reaches the test period.
        train_mask &= data["label_resolved_at"].notna() & (data["label_resolved_at"] < test_start)
        # When an earlier outer-test block later becomes eligible for the
        # expanding training set, preserve its 24-hour post-test embargo.
        for start, end in prior_embargoes:
            train_mask &= ~data["detected_at"].between(start, end, inclusive="right")
        train = data.loc[train_mask]
        if len(test) >= min_test_rows and len(train) >= min_test_rows and train["y"].nunique() == 2 and test["y"].nunique() == 2:
            folds.append(Fold(len(folds), train.index.to_numpy(), test.index.to_numpy(), test_start, test_end, tuple(prior_embargoes)))
            prior_embargoes.append((test_end, test_end + embargo_ms))
        prior_groups.extend(block)
    return folds

def naive_shuffled_splits(frame: pd.DataFrame, n_splits: int = 5) -> list[Fold]:
    data = frame.loc[frame["y"].isin([0, 1])]
    if len(data) < n_splits or data["y"].value_counts().min() < n_splits:
        return []
    cv = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=SEED)
    result = []
    for number, (train_pos, test_pos) in enumerate(cv.split(data, data["y"].astype(int))):
        result.append(Fold(number, data.index.to_numpy()[train_pos], data.index.to_numpy()[test_pos], float("nan"), float("nan")))
    return result

def validate_fold(frame: pd.DataFrame, fold: Fold, embargo_hours: int = 24) -> None:
    train, test = frame.loc[fold.train], frame.loc[fold.test]
    assert set(train["group_id"]).isdisjoint(set(test["group_id"]))
    assert (train["detected_at"] < fold.test_start_ms - embargo_hours * 60 * 60 * 1000).all()
    assert (train["label_resolved_at"] < fold.test_start_ms).all()
    for start, end in fold.embargo_intervals:
        assert (~train["detected_at"].between(start, end, inclusive="right")).all()

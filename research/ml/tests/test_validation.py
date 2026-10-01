import pandas as pd

from scanner_ml.validation import validate_fold, walk_forward_splits

def timeline():
    rows=[]
    base=1_700_000_000_000
    for group in range(12):
        for repeat in range(2):
            detected=base+group*72*60*60*1000+repeat*5*60*1000
            rows.append({"id":f"{group}-{repeat}","group_id":f"g{group}","detected_at":detected,"label_resolved_at":detected+12*60*60*1000,"y":(group+repeat)%2})
    return pd.DataFrame(rows)

def test_walk_forward_purges_windows_enforces_gap_and_keeps_groups_together():
    frame=timeline();folds=walk_forward_splits(frame,n_splits=3,min_test_rows=4,embargo_hours=24)
    assert len(folds)>=2
    for fold in folds:
        validate_fold(frame,fold)
        assert set(frame.loc[fold.train,"group_id"]).isdisjoint(set(frame.loc[fold.test,"group_id"]))

def test_overlapping_label_window_never_enters_training():
    frame=timeline();folds=walk_forward_splits(frame,n_splits=3,min_test_rows=4,embargo_hours=0)
    fold=folds[0];candidate=fold.train[0];frame.loc[candidate,"label_resolved_at"]=fold.test_start_ms+1
    rebuilt=walk_forward_splits(frame,n_splits=3,min_test_rows=4,embargo_hours=0)[0]
    assert candidate not in set(rebuilt.train)

def test_prior_test_post_embargo_is_excluded_from_later_training():
    frame=timeline()
    first_test_end=frame.loc[frame.group_id.isin(["g3","g4","g5"]),"detected_at"].max()
    moved=frame.group_id.eq("g6")
    frame.loc[moved,"detected_at"]=[first_test_end+60*60*1000,first_test_end+65*60*1000]
    frame.loc[moved,"label_resolved_at"]=frame.loc[moved,"detected_at"]+12*60*60*1000
    folds=walk_forward_splits(frame,n_splits=3,min_test_rows=4,embargo_hours=24)
    assert len(folds)>=3
    forbidden=set(frame.index[moved])
    assert forbidden.isdisjoint(set(folds[2].train))
    assert folds[2].embargo_intervals

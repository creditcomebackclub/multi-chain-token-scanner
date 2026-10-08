import hashlib
import json

import numpy as np
import pandas as pd

from scanner_ml.data import FEATURES_WITHOUT_RISK
from scanner_ml.strategy_discovery import (
    BAR, HOUR, EXITS, candidate_rows, choose, clean_json, first_per_token_day,
    fit_return_model, mean_interval, oof_scores, paired_difference, pattern_masks,
    portfolio, prepare, prior_training, run_study,
)


def observations(days=7, tokens=12):
    rows = []
    for day in range(days):
        for token in range(tokens):
            at = pd.Timestamp('2026-09-20', tz='UTC').value // 1_000_000 + day*24*HOUR + token*BAR
            rows.append({**dict.fromkeys(FEATURES_WITHOUT_RISK, 0.0),
                         'id': f'{day}-{token}', 'chain': 'solana', 'token': f't{token}',
                         'pool': f'p{token}', 'support_anchor': np.nan, 'detected_at': at,
                         'entry_price': 100, 'riskPct': 3, 'atrPct': 2, 'atr14': 2,
                         'bodyPct': .5, 'lowerWickPct': .25, 'upperWickPct': .25, 'closePosition': .75,
                         'volumeRatio': 1.5, 'ema9SlopePct': .1, 'ema21SlopePct': .1,
                         'priceToEma9Pct': 1, 'ema9ToEma21Pct': .5, 'priceToSma50Pct': 1,
                         'priorPeakDrawdownPct': -10, 'supportTestCount': 2,
                         'entry_at': at+BAR, 'exit_at': at+2*BAR, 'fill_price': 100,
                         'net_return_pct': 2+token/10, 'gross_return_pct': 4+token/10,
                         'resolved': True, 'exit_reason': 'tp'})
    return prepare(pd.DataFrame(rows))


def test_green_geometry_and_patterns_use_recorded_candle_only():
    frame = observations(1, 3)
    frame.loc[1, 'closePosition'] = .25  # Same wicks/body, but red.
    frame.loc[1, 'green'] = False
    frame.loc[2, 'volumeRatio'] = .5
    assert pattern_masks(frame)['support_reclaim'].tolist() == [True, False, False]
    red = frame.iloc[[1]].drop(columns=['green'])
    assert not prepare(red).green.iloc[0]
    assert 'riskPct' not in FEATURES_WITHOUT_RISK


def test_first_attempt_is_not_replaced_by_a_later_winning_or_resolved_entry():
    frame = observations(1, 1)
    first = frame.assign(resolved=False, net_return_pct=np.nan)
    second = frame.assign(id='later', detected_at=frame.detected_at+BAR, resolved=True, net_return_pct=100)
    rows = pd.concat([first, second], ignore_index=True)
    selected = candidate_rows(rows, 'support_reclaim')
    assert selected.id.tolist() == ['0-0']
    assert not selected.resolved.iloc[0]
    assert first_per_token_day(rows).id.tolist() == ['0-0']


def test_training_purges_label_horizon_and_repeated_support_groups():
    frame = observations(5, 12)
    test = frame.loc[frame.day.eq(frame.day.max())].copy()
    last_start = test.day.min().value // 1_000_000
    frame.loc[0, ['anchored', 'group']] = [True, 'shared']
    test.loc[test.index[0], ['anchored', 'group']] = [True, 'shared']
    frame.loc[1, 'exit_at'] = last_start  # Not available strictly before the test.
    frame.loc[2, 'detected_at'] = last_start-5*HOUR  # Inside the six-hour gap.
    train = prior_training(frame, test)
    assert not {'0-0', '0-1', '0-2'} & set(train.id)
    assert train.detected_at.max() < last_start-6*HOUR
    assert train.exit_at.max() < last_start


def test_missing_first_training_labels_cannot_be_replaced_with_later_labels():
    frame = observations(3, 10)
    missing = frame.assign(resolved=False, net_return_pct=np.nan)
    later = frame.assign(id='later-'+frame.id, detected_at=frame.detected_at+BAR)
    assert fit_return_model(pd.concat([missing, later], ignore_index=True)) is None


def test_future_outcomes_cannot_change_earlier_model_scores():
    frame = observations()
    scores = oof_scores(frame)
    assert scores.notna().any()
    changed = frame.copy()
    changed.loc[changed.day.eq(changed.day.max()), 'net_return_pct'] = -90
    earlier = frame.day.lt(frame.day.max())
    np.testing.assert_allclose(scores.loc[earlier], oof_scores(changed).loc[earlier], equal_nan=True)


def test_cost_labels_change_return_model_intercept_and_entry_gate():
    frame = observations()
    expensive = frame.assign(net_return_pct=frame.net_return_pct-4)
    cheap_scores, costly_scores = oof_scores(frame), oof_scores(expensive)
    valid = cheap_scores.notna()
    np.testing.assert_allclose(costly_scores.loc[valid], cheap_scores.loc[valid]-4, atol=1e-10)
    assert len(candidate_rows(frame, 'return_ranked_ml', cheap_scores)) > 0
    assert len(candidate_rows(expensive, 'return_ranked_ml', costly_scores)) == 0


def test_small_or_degenerate_bootstraps_have_no_numeric_interval():
    two_days = observations(2)
    assert mean_interval(two_days)['ci'] is None
    assert paired_difference(two_days, two_days)['ci'] is None
    constant = observations(4).assign(net_return_pct=2)
    assert mean_interval(constant)['ci'] is None
    varied = observations(4)
    varied['net_return_pct'] += varied.day.rank(method='dense')
    assert mean_interval(varied)['ci'] is not None


def test_unknown_positions_reserve_capital_and_capacity_before_profit_is_known():
    frame = observations(1, 5)
    frame['entry_at'] = frame.entry_at.min()
    frame['exit_at'] = frame.entry_at+6*HOUR
    frame['resolved'] = False
    frame['net_return_pct'] = np.nan
    result = portfolio(frame)
    assert result['fills'] == 3
    assert result['skipped_capacity_or_fill'] == 2
    assert result['pnl'] == 0
    assert result['filled_ids'] == ['0-0', '0-1', '0-2']


def test_no_positive_candidate_means_cash_and_json_preserves_booleans():
    rows = observations().assign(net_return_pct=-1)
    assert choose({'candidate': rows}) is None
    assert clean_json({'promotable': False, 'missing': np.nan}) == {'promotable': False, 'missing': None}


def test_full_study_runs_on_synthetic_data_without_production_artifacts(tmp_path):
    frame = observations()
    snapshot = tmp_path/'snapshot.csv'
    frame.drop(columns=['entry_at', 'exit_at', 'fill_price', 'net_return_pct', 'gross_return_pct',
                        'resolved', 'exit_reason']).to_csv(snapshot, index=False)
    meta = {'exported_at': '2026-10-01T00:00:00Z', 'csv_sha256': hashlib.sha256(snapshot.read_bytes()).hexdigest()}
    snapshot.with_name('snapshot.meta.json').write_text(json.dumps(meta))
    blocks = []
    for delay in [0, 1]:
        for exit in EXITS:
            blocks.append(frame[['id', 'entry_at', 'exit_at', 'net_return_pct', 'gross_return_pct', 'resolved', 'exit_reason']]
                          .assign(exit=exit, delay_bars=delay, entry_price=100))
    replay = tmp_path/'replay.csv'
    pd.concat(blocks).to_csv(replay, index=False)
    result = run_study(snapshot, replay, tmp_path/'report', samples=50, permutations=2)
    assert result['candidate_count'] == 12
    assert result['live_promotable'] is False
    assert result['confirmation'] == {}
    assert result['frozen_candidate']
    assert json.loads((tmp_path/'report/results.json').read_text())['live_promotable'] is False
    assert 'not estimable' in (tmp_path/'report/REPORT.md').read_text()


def test_confirmation_cannot_replace_the_frozen_candidate_with_a_later_winner(tmp_path):
    def write_inputs(frame, root, confirmation=False):
        root.mkdir()
        snapshot = root/'snapshot.csv'
        frame.drop(columns=['entry_at', 'exit_at', 'fill_price', 'net_return_pct', 'gross_return_pct',
                            'resolved', 'exit_reason']).to_csv(snapshot, index=False)
        meta = {'exported_at': '2026-10-08T00:00:00Z',
                'csv_sha256': hashlib.sha256(snapshot.read_bytes()).hexdigest()}
        snapshot.with_name('snapshot.meta.json').write_text(json.dumps(meta))
        blocks = []
        for delay in [0, 1]:
            for exit in EXITS:
                block = frame[['id', 'entry_at', 'exit_at', 'net_return_pct', 'gross_return_pct', 'resolved', 'exit_reason']].copy()
                if confirmation:
                    block['net_return_pct'] = -3 if exit == 'trail' else 20
                    block['gross_return_pct'] = block.net_return_pct+2
                blocks.append(block.assign(exit=exit, delay_bars=delay, entry_price=100))
        replay = root/'replay.csv'
        pd.concat(blocks).to_csv(replay, index=False)
        return snapshot, replay

    development = observations().assign(volumeRatio=2, lowerWickPct=.3, upperWickPct=.2, closePosition=.8)
    snapshot, replay = write_inputs(development, tmp_path/'dev')
    fresh = observations(5).assign(volumeRatio=2, lowerWickPct=.3, upperWickPct=.2, closePosition=.8)
    shift = 13*24*HOUR  # September 20 -> October 3.
    for column in ['detected_at', 'entry_at', 'exit_at']:
        fresh[column] += shift
    confirmation_snapshot, confirmation_replay = write_inputs(fresh, tmp_path/'fresh', True)
    result = run_study(snapshot, replay, tmp_path/'report', confirmation_snapshot,
                       confirmation_replay, samples=50, permutations=2)
    assert result['frozen_candidate'] == 'volume_ignition|trail'
    assert result['confirmation']['volume_ignition|runner']['expectancy']['estimate'] == 20
    assert result['frozen_confirmation_checks']['mean_at_200bps'] == -3
    assert result['frozen_confirmation_checks']['mean_at_300bps'] == -4
    assert len(result['confirmation_sensitivity']) == 6
    assert next(item['mean'] for item in result['confirmation_sensitivity']
                if item['delay_minutes'] == 5 and item['cost_bps'] == 300) == -4
    assert result['worth_prospective_testing'] is False
    assert result['live_promotable'] is False
    report = (tmp_path/'report/REPORT.md').read_text()
    assert 'registered confirmation criterion not met' in report
    assert 'confirmation unavailable' not in report

"""Measure actual worker functions on a synthetic CSV; no model or Office access."""
import argparse
import csv
import importlib.util
import json
from pathlib import Path
import statistics
import time
import tracemalloc


parser = argparse.ArgumentParser()
parser.add_argument('--before', required=True)
parser.add_argument('--after')
parser.add_argument('--report', required=True)
parser.add_argument('--rows', type=int, default=100000)
args = parser.parse_args()
root = Path('../..').resolve()
folder = root / '.tools/qa/streaming-fixtures'
folder.mkdir(parents=True, exist_ok=True)
source = folder / f'memory-{args.rows}.csv'
with source.open('w', encoding='utf-8-sig', newline='') as stream:
    writer = csv.writer(stream)
    for row in range(args.rows):
        writer.writerow([f'Row {row:06d} cell {column:02d}' for column in range(16)])
modules = []
for label, path in [('before', args.before), ('after', args.after)]:
    if path is None:
        continue
    spec = importlib.util.spec_from_file_location(label, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    modules.append((label, module))
report = {'fileBytes': source.stat().st_size, 'rows': args.rows, 'samples': [], 'summary': []}
offset = args.rows // 2
for action in ['grid', 'validate']:
    for sample in range(3):
        for label, module in modules if sample % 2 == 0 else reversed(modules):
            tracemalloc.start()
            started = time.perf_counter()
            result = module.grid(source, offset=offset, limit=200) if action == 'grid' else module.validate(source)
            elapsed = time.perf_counter() - started
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            if action == 'grid':
                assert result['total'] == args.rows
                assert len(result['rows']) == 200
                assert result['rows'][0][0] == f'Row {offset:06d} cell 00'
                assert result['rows'][-1][-1] == f'Row {offset + 199:06d} cell 15'
            else:
                assert result['size'] == source.stat().st_size
                if 'hash' in report:
                    assert result['hash'] == report['hash']
                report['hash'] = result['hash']
            report['samples'].append({'action': action, 'label': label, 'seconds': elapsed, 'pythonPeakBytes': peak})
            print(action, label, sample, round(elapsed, 3), peak, flush=True)
    for label, _ in modules:
        samples = [value for value in report['samples'] if value['action'] == action and value['label'] == label]
        report['summary'].append({'action': action, 'label': label, 'medianSeconds': statistics.median(value['seconds'] for value in samples), 'medianPythonPeakBytes': statistics.median(value['pythonPeakBytes'] for value in samples)})
Path(args.report).write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report['summary']), flush=True)

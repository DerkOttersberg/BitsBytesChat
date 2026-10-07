"""Compare repeat Word previews with the retained pre-cache source checkpoint."""
import hashlib
import importlib.util
import json
from pathlib import Path
import statistics
import subprocess
import time
import uuid

root = Path(__file__).resolve().parents[3]
folder = root / '.tools/qa' / ('office-performance-' + uuid.uuid4().hex)
folder.mkdir(parents=True)
baseline = folder / 'baseline.py'
baseline.write_bytes(subprocess.check_output(['git', 'show', 'ce1226599:packages/desktop/resources/bitsbytes/artifact_worker.py'], cwd=root))

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

before = load('before_cache', baseline)
after = load('after_cache', root / 'packages/desktop/resources/bitsbytes/artifact_worker.py')
document = after.create({'filename': 'Repeat preview.docx', 'title': 'Preview performance QA',
    'blocks': [{'text': 'Synthetic data: verified original content.'}, {'type': 'table', 'rows': [['Name', 'Value'], ['Test', '42']]}]}, folder)
path = Path(document['path'])
original = hashlib.sha256(path.read_bytes()).hexdigest()
started = time.perf_counter()
after.render(path, folder / 'after')
first = time.perf_counter() - started
samples = []
for index in range(3):
    for label, worker in [('before', before), ('after', after)]:
        started = time.perf_counter()
        preview = worker.render(path, folder / label)
        seconds = time.perf_counter() - started
        assert Path(preview['pdf']).read_bytes().startswith(b'%PDF-')
        assert hashlib.sha256(path.read_bytes()).hexdigest() == original
        samples.append({'build': label, 'seconds': seconds})
report = {'workload': 'Three serial interleaved repeat exports of one unchanged Word document; installed Microsoft Word',
    'baseline': 'ce1226599', 'firstExportSeconds': first, 'samples': samples,
    'medianSeconds': {label: statistics.median(row['seconds'] for row in samples if row['build'] == label) for label in ['before', 'after']}}
(root / '.tools/qa/results/office-cache-performance-033.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import artifact_worker as worker


class ArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = Path(tempfile.mkdtemp(prefix='bitsbytes-artifacts-qa-'))
        cls.results = []

    def test_office_creation_render_and_snapshots(self):
        cases = [
            {'filename': 'Test.docx', 'title': 'Dutch intake verification', 'blocks': [{'type': 'heading', 'text': 'Afspraken'}, {'text': 'De deelnemer oefent twee dagen per week met ICT.'}, {'type': 'table', 'rows': [['Naam', 'Afspraak'], ['Testpersoon', 'Onbekende velden blijven leeg']]}]},
            {'filename': 'Test.xlsx', 'sheets': [{'name': 'Results', 'rows': [['Value', 'Total'], [12, '=SUM(A2:A3)'], [8, '=A2*A3']]}]},
            {'filename': 'Test.pptx', 'slides': [{'title': 'Local artifact test', 'bullets': ['Preserved conversation context', 'Preview and chat corrections'], 'notes': 'QA example, no participant data.'}, {'title': 'Verification', 'bullets': ['Read actual files', 'Check every rendered page']}]},
        ]
        for spec in cases:
            with self.subTest(spec=spec['filename']):
                result = worker.create(spec, self.folder)
                path = Path(result['path'])
                original = hashlib.sha256(path.read_bytes()).hexdigest()
                preview = worker.render(path, self.folder / 'previews')
                self.assertEqual(original, hashlib.sha256(path.read_bytes()).hexdigest())
                self.assertEqual(Path(preview['pdf']).read_bytes()[:5], b'%PDF-')
                images = worker.pages(preview['pdf'], self.folder / (path.name + '-pages'))
                self.assertGreater(images['pages'], 0)
                if path.suffix == '.xlsx':
                    grid = worker.grid(Path(preview['pdf']).with_suffix('.xlsx'))
                    self.assertEqual(grid['rows'][1][1], '20')
                    self.assertEqual(grid['rows'][2][1], '96')
                    self.assertEqual(preview['formulaErrors'], [])
                modified = Path(preview['pdf']).stat().st_mtime_ns
                with mock.patch.object(worker, 'office', side_effect=AssertionError('Cached preview must not reopen Office')):
                    again = worker.render(path, self.folder / 'previews')
                self.assertEqual(again, preview)
                self.assertEqual(Path(preview['pdf']).stat().st_mtime_ns, modified)
                self.results.append({'file': result, 'preview': preview, 'images': images})

    def test_damaged_preview_cache_recovers_from_source(self):
        result = worker.create({'filename': 'Cache recovery.docx', 'blocks': [{'text': 'Verified cache recovery'}]}, self.folder)
        preview = worker.render(result['path'], self.folder / 'cache-recovery')
        Path(preview['pdf']).write_bytes(b'Damaged cached PDF')
        with mock.patch.object(worker, 'office', wraps=worker.office) as export:
            recovered = worker.render(result['path'], self.folder / 'cache-recovery')
            self.assertEqual(export.call_count, 1)
        self.assertEqual(Path(recovered['pdf']).read_bytes()[:5], b'%PDF-')

    def test_pdf_csv_html_and_code(self):
        cases = [{'filename': 'Test.pdf', 'title': 'Verified PDF', 'blocks': [{'text': 'Complete, searchable content.'}]}, {'filename': 'Test.csv', 'rows': [['Naam', 'Afspraak'], ['Één deelnemer', 'Comma, quoted']]}, {'filename': 'Test.html', 'text': '<!doctype html><h1>Isolated preview</h1>'}, {'filename': 'Test.py', 'text': 'print("Dutch: één")\n'}]
        for spec in cases:
            result = worker.create(spec, self.folder)
            self.assertGreater(worker.validate(result['path'])['size'], 0)
            if result['kind'] == 'spreadsheet':
                self.assertEqual(worker.grid(result['path'])['rows'][1][1], 'Comma, quoted')

    def test_invalid_sources_and_filename(self):
        with self.assertRaises(ValueError):
            worker.create({'filename': '../escape.docx'}, self.folder)
        fake = self.folder / 'fake.docx'
        fake.write_text('Not a Word document')
        with self.assertRaises(Exception):
            worker.validate(fake)

    @classmethod
    def tearDownClass(cls):
        (cls.folder / 'results.json').write_text(json.dumps(cls.results, indent=2), encoding='utf-8')
        print('QA_ARTIFACT_FOLDER=' + str(cls.folder))


if __name__ == '__main__':
    unittest.main()

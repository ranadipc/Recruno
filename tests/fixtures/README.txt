RESUME EXTRACTION EDGE CASE TEST PACK

Purpose
These ten synthetic resumes test whether the evaluator preserves both words and layout relationships.
All names, contact details, companies, projects, and results are fictional.

How to test
1. Create a separate test project in the Resume Evaluator.
2. Upload the files from the resumes folder.
3. Grade one resume at a time so each result is easy to inspect.
4. Confirm every mustContain value appears in the model result.
5. Confirm each relationship stays correct. A value found in the wrong row, column, job, or bullet level is a failure.
6. Confirm TEST-08 uses page-images because it is an image-only scan.
7. Record Pass, Warning, or Fail in the test-results-template.csv file.

Important
A high model score is not the purpose of these files. The test passes only when the right facts remain connected.

Test cases
TEST-01 | 01_nested_bullets.pdf | Three-level nested bullets
TEST-02 | 02_two_columns.pdf | Two independent page columns
TEST-03 | 03_skills_table.pdf | Four-column skills table
TEST-04 | 04_table_inside_column.pdf | Table embedded inside a page column
TEST-05 | 05_job_date_alignment.pdf | Dates right-aligned beside job headings
TEST-06 | 06_repeated_headers_footers.pdf | Repeated header and footer across three pages
TEST-07 | 07_symbols_and_identifiers.pdf | Symbols, punctuation, email aliases, URLs, and version numbers
TEST-08 | 08_scanned_image_only.pdf | Image-only scanned resume with no PDF text layer
TEST-09 | 09_mixed_layout_sections.pdf | Full-width, three-card, two-column, and table layouts in one resume
TEST-10 | 10_docx_table_and_nested_lists.docx | DOCX nested lists, four-column table, and merged table cell

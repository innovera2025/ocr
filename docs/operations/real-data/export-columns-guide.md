# Export column guide (CSV / JSONL)

**Applies from:** tag `export-full-confidence-1` (2026-10-08). **Code:** `packages/ocr-persistence/src/export.ts`
(the column table below is generated from `EXPORT_COLUMNS_DETAILED` and pinned to it by a test in `export.test.ts`).

## Which file to pick

The export dialog (ส่งออก) has two column sets:

| Dialog choice | API value (`columns=`) | Columns | Use it for |
|---|---|---|---|
| **ทั้งหมด (รวม % ความมั่นใจ)** (default) | `detailed` (also the default when `columns` is omitted) | 180 | Hand-editing in Excel: every field, what the OCR read, how sure it was, and which fields staff changed. |
| สรุป | `compact` | 57 | The short file: one cell per field. |

The full set is the compact set (columns 1-57, same order) plus 123 appended columns, so column 1-57 are in the same
position in both files.

## What the numbers mean

- **All confidences are integer percent 0-100**, rounded exactly like the review drawer and the document list
  (0.894 -> 89, 0.895 -> 90). A stored value already above 1 is read as a percent.
- **`*_confidence` (ความมั่นใจ %)** is the *effective* confidence:
  - a field a staff member **changed or added** is **100** (a person set it; it does not mean the OCR was right);
  - a field the reviewer only **accepted without changing** keeps its OCR % (accepting is not a correction);
  - an **unread** field (nothing found and not flagged) and a **missing** field are empty.
- **`*_ocr_confidence` (ความมั่นใจ OCR เดิม %)** is the OCR's own confidence. For a field nobody edited it equals
  `*_confidence`. For an edited field it is the OCR % the save kept, so you can see how sure the machine was before
  the correction. It is empty when staff **added** the value (no OCR reading existed) or filled a field where the OCR
  had read no text.
- **`*_edited` (แก้ไขโดยพนักงาน)** is TRUE when a staff member changed or added the value (stored source `human`).
  For a list it is TRUE when any item was changed or added; for a treatment when its name or duration was.
- **`*_needs_review` (ต้องตรวจ)** is TRUE while the field is still flagged. A save or a confirmation clears the flags.
- **`min_confidence` (ความมั่นใจต่ำสุด (%))** is the lowest effective % of the whole document, using the same two
  rules (edited = 100, unread skipped). It also covers fields without their own columns (treatments 5 and up), so it
  can be lower than every per-field column. Lowest OCR % instead: take the MIN of the `*_ocr_confidence` columns.
- **Lists** (`referral_sources`, `health_conditions`, `massage_oil_scrub`, `preferred_areas`, `avoid_areas`) get one
  set of columns each over their items: `_raw` joins the items' OCR texts with `; `, `_confidence` and
  `_ocr_confidence` are the lowest item %, `_needs_review` / `_edited` are TRUE when any item is. A list with no
  items has all five empty.
- **Treatments 1-4** each get `_raw` (the service as written), `_confidence`, `_ocr_confidence`, `_edited` and
  `_guests`. Treatments 5 and up stay in `treatments_more` (value only).

### The three OCR-only summary columns (columns 55-57, both sets; also the line at the top of the review drawer)

They say how well the **machine** read the form and never use the 100 of an edit, so reviewing a document does not
move them.

- *Handwritten fields:* form number, date, time, customer name, nationality, hotel, the two "Others" texts,
  therapist, room, and every treatment (name and duration together, all of them). Branch is in neither group.
- A handwritten field **had writing** when the OCR produced text there, or found ink it could not read (`none`
  flagged for review). The ink check saying "empty" (`ink-mark`) means no writing.
- `handwriting_read` = `N จาก M`: N of the M fields with writing were read into a value. It is written in words on
  purpose: Excel would turn `7/9` into a date. The drawer shows the same numbers as `อ่านได้ 7/9 ช่อง`.
- `handwriting_confidence` = the mean original OCR % of those M fields (an unread one counts 0); empty when M = 0.
- `checkbox_confidence` = the mean original OCR % over the checkbox marks (gender, pressure and the ticked list
  items the checkbox reader judged); empty when there are none.
- Edited fields count with the OCR reading they kept. **Known limits:** a field staff typed where the OCR had no
  text is left out (its OCR state is not stored); a save or confirmation clears every review flag, so after it a
  field whose ink the OCR could not read no longer counts as writing; an edited field that the OCR had text for but
  could not turn into a value counts as read.

## Empty cells

Every column is present in every row. A missing field, an empty list or an absent treatment slot is an **empty CSV
cell** and **`null` in JSONL** (never FALSE, never left out). Old documents (legacy v2.2 results, documents read before
the form header existed) export the same columns, mostly empty.

## Source codes (`*_source`)

The `_source` cell holds the raw machine code so it can be filtered; the drawer shows it in Thai:

| Code | Thai (drawer) | Meaning |
|---|---|---|
| `ocr` | อ่านด้วย OCR | Read from handwriting by the model. |
| `checkbox` | จากช่องทำเครื่องหมาย | From the checkbox reader. |
| `ink-mark` | ตรวจจากรอยหมึก | From the ink check (for example an empty date box). |
| `rule` | ตามกฎของระบบ | Derived by a system rule. |
| `master-fuzzy` | เทียบกับรายการบริการ | Matched against the master list. |
| `visual-alias` | เดาจากลายมือที่มักอ่านผิด (ต้องตรวจ) | A known handwriting confusion; must be checked. |
| `verified-memory` | จากข้อมูลที่เคยยืนยัน | From corrections staff confirmed before. |
| `none` | ไม่พบข้อมูล | Nothing found. |
| `human` | แก้ไขโดยพนักงาน | Changed or added by staff. |

## Notice for anyone who used earlier files (column shift)

- **สรุป (compact): 54 -> 57 columns.** Columns 1-54 are unchanged in key, Thai header and position, except that
  `min_confidence` changed from a 0-1 fraction to an integer percent (a filter `< 0.8` is now `< 80`) and its header
  is now "ความมั่นใจต่ำสุด (%)". Three columns were appended at the end (55-57).
- **ละเอียด -> ทั้งหมด (detailed): 106 -> 180 columns, layout replaced.** Every `*_confidence` is now a percent and
  means the effective confidence; `_ocr_confidence` and `_edited` were added to each field group, so the columns after
  57 moved. Lists and treatments gained their own columns.
- The default changed: a download without a choice is now the full set (the dialog and the API alike).
- Files exported before 2026-10-08 keep the old meaning.

## เปิดไฟล์ใน Excel

- ดับเบิลคลิกเปิดได้ (ไฟล์มี BOM จึงแสดงภาษาไทยถูกต้อง) แต่ Excel จะตัดเลข 0 ข้างหน้า เช่น ห้อง `007` กลายเป็น `7`
- วิธีที่แนะนำ: Excel > Data > From Text/CSV > เลือกไฟล์ > File origin **65001: Unicode (UTF-8)** > Delimiter
  **Comma** > กด Transform Data แล้วตั้งคอลัมน์ `room`, `form_number`, `document_id`, `batch_id`,
  `parent_document_id` (และคอลัมน์ `_raw` ของสองช่องนี้) เป็น **Text** ก่อนกด Load เลข 0 ข้างหน้าจะไม่หาย
- คอลัมน์ `handwriting_read` เขียนเป็นคำ เช่น `7 จาก 9` โดยตั้งใจ เพราะ Excel จะเปลี่ยน `7/9` เป็นวันที่
- ตัวเลขสามคอลัมน์สรุป (55-57) วัดเฉพาะการอ่านของเครื่อง ไม่นับค่า 100 ของช่องที่พนักงานแก้
- ไฟล์ "ทั้งหมด" มี 180 คอลัมน์: ตรึงแถวแรก (View > Freeze Top Row) แล้วซ่อนกลุ่มคอลัมน์ที่ไม่ใช้ หรือกรอง
  คอลัมน์ `_edited` = TRUE เพื่อดูเฉพาะช่องที่แก้ไข
- ระบบไม่มีไฟล์ .xlsx (มีเฉพาะ CSV และ JSONL)

## All 180 columns, in file order

Columns 1-57 are also the สรุป (compact) file.

<!-- columns:start -->
| # | Key (`headers=en`) | Thai header (default) | Kind | Meaning |
|---|---|---|---|---|
| 1 | `original_file_name` | ชื่อไฟล์ต้นฉบับ | text | Name of the uploaded file (for a page of a PDF: the PDF's name). |
| 2 | `page` | หน้า | number | Page number inside the PDF; empty for a single image. |
| 3 | `page_count` | จำนวนหน้า | number | Number of pages of that PDF; empty for a single image. |
| 4 | `uploaded_at` | อัปโหลดเมื่อ | datetime | Upload time, Bangkok (`YYYY-MM-DD HH:MM:SS`). |
| 5 | `batch_label` | ชุดอัปโหลด | text | Label of the upload batch. |
| 6 | `status` | สถานะ | text | Status in Thai (the list's badge). |
| 7 | `reviewed` | ยืนยันแล้ว | bool | TRUE once a staff member confirmed the document. |
| 8 | `reviewed_at` | ยืนยันเมื่อ | datetime | Confirmation time, Bangkok. |
| 9 | `reviewed_by` | ยืนยันโดย | text | Who confirmed it. |
| 10 | `form_number` | เลขที่ฟอร์ม | text | Form number (value; `(?)` = not verified). |
| 11 | `form_date` | วันที่ | text | Date written on the form. |
| 12 | `form_time` | เวลา | text | Time written on the form. |
| 13 | `branch` | สาขา | text | Branch. |
| 14 | `customer_name` | ชื่อลูกค้า | text | Customer name. |
| 15 | `gender` | เพศ | text | Gender (checkbox). |
| 16 | `nationality` | สัญชาติ | text | Nationality. |
| 17 | `hotel_name` | โรงแรมที่พัก | text | Hotel. |
| 18 | `referral_sources` | รู้จักร้านจาก | text | How the customer heard of the shop (ticked boxes, joined with `; `). |
| 19 | `referral_other` | รู้จักร้านจาก: อื่น ๆ (ระบุ) | text | "Others" text of the referral group. |
| 20 | `health_conditions` | ภาวะสุขภาพ | text | Health conditions (ticked boxes, joined with `; `). |
| 21 | `health_other` | ภาวะสุขภาพ: อื่น ๆ (ระบุ) | text | "Others" text of the health group. |
| 22 | `pressure` | แรงกด | text | Massage pressure (checkbox). |
| 23 | `massage_oil_scrub` | น้ำมัน / สครับ | text | Oil / scrub (ticked boxes). |
| 24 | `preferred_areas` | จุดที่ต้องการเน้น | text | Areas to focus on. |
| 25 | `avoid_areas` | จุดที่ควรหลีกเลี่ยง | text | Areas to avoid. |
| 26 | `treatments` | ทรีตเมนต์ | text | Every treatment with its duration, joined with `; `. |
| 27 | `treatment_1_name` | ทรีตเมนต์ 1 | text | Treatment 1: service. |
| 28 | `treatment_1_duration` | ระยะเวลา 1 | text | Treatment 1: duration as written. |
| 29 | `treatment_1_minutes` | นาที 1 | number | Treatment 1: duration in minutes. |
| 30 | `treatment_2_name` | ทรีตเมนต์ 2 | text | Treatment 2: service. |
| 31 | `treatment_2_duration` | ระยะเวลา 2 | text | Treatment 2: duration as written. |
| 32 | `treatment_2_minutes` | นาที 2 | number | Treatment 2: duration in minutes. |
| 33 | `treatment_3_name` | ทรีตเมนต์ 3 | text | Treatment 3: service. |
| 34 | `treatment_3_duration` | ระยะเวลา 3 | text | Treatment 3: duration as written. |
| 35 | `treatment_3_minutes` | นาที 3 | number | Treatment 3: duration in minutes. |
| 36 | `treatment_4_name` | ทรีตเมนต์ 4 | text | Treatment 4: service. |
| 37 | `treatment_4_duration` | ระยะเวลา 4 | text | Treatment 4: duration as written. |
| 38 | `treatment_4_minutes` | นาที 4 | number | Treatment 4: duration in minutes. |
| 39 | `treatments_more` | ทรีตเมนต์ (รายการที่ 5 ขึ้นไป) | text | Treatments 5 and up, joined with `; ` (no per-item columns). |
| 40 | `total_minutes` | รวมนาที | number | Total minutes written on the form. |
| 41 | `therapist` | พนักงานนวด | text | Therapist. |
| 42 | `room` | ห้อง | text | Room (text: keep leading zeros). |
| 43 | `needs_review` | ต้องตรวจสอบ | bool | TRUE while any field is still flagged for review. |
| 44 | `review_fields` | ช่องที่ต้องตรวจ | text | Paths of the flagged fields, joined with `; `. |
| 45 | `min_confidence` | ความมั่นใจต่ำสุด (%) | number | Lowest confidence % of the document (an edited field counts as 100, an unread one is skipped). Integer 0-100. |
| 46 | `delivery_status` | การส่งการแก้ไขให้ AI | text | Whether the corrections reached the AI's memory. |
| 47 | `error_message` | ข้อความผิดพลาด | text | Error text of a failed read. |
| 48 | `template` | แม่แบบที่ตรวจพบ | text | Detected form template. |
| 49 | `processed_at` | อ่านเสร็จเมื่อ | datetime | Time the OCR finished, Bangkok. |
| 50 | `review_url` | ลิงก์ตรวจสอบ | text | Link to the review drawer. |
| 51 | `document_id` | รหัสเอกสาร | text | Document id. |
| 52 | `batch_id` | รหัสชุดอัปโหลด | text | Upload batch id. |
| 53 | `parent_document_id` | รหัสเอกสารต้นฉบับ | text | Id of the PDF a page belongs to. |
| 54 | `status_code` | รหัสสถานะ | text | Raw status code. |
| 55 | `handwriting_confidence` | % อ่านลายมือ (OCR) | number | OCR-only: mean original OCR % over the handwritten fields that had writing (an unread one counts 0). Never the 100 of an edit. |
| 56 | `handwriting_read` | ลายมืออ่านได้ (ช่อง) | text | OCR-only: `N จาก M` = the OCR read N of the M handwritten fields that had writing (words on purpose: Excel turns 7/9 into a date). |
| 57 | `checkbox_confidence` | % ช่องติ๊ก (OCR) | number | OCR-only: mean original OCR % over the checkbox marks. |
| 58 | `form_number_raw` | เลขที่ฟอร์ม (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 59 | `form_number_confidence` | เลขที่ฟอร์ม (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 60 | `form_number_ocr_confidence` | เลขที่ฟอร์ม (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 61 | `form_number_needs_review` | เลขที่ฟอร์ม (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 62 | `form_number_source` | เลขที่ฟอร์ม (ที่มา) | text | Raw source code (see the source table). |
| 63 | `form_number_edited` | เลขที่ฟอร์ม (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 64 | `form_date_raw` | วันที่ (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 65 | `form_date_confidence` | วันที่ (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 66 | `form_date_ocr_confidence` | วันที่ (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 67 | `form_date_needs_review` | วันที่ (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 68 | `form_date_source` | วันที่ (ที่มา) | text | Raw source code (see the source table). |
| 69 | `form_date_edited` | วันที่ (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 70 | `form_time_raw` | เวลา (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 71 | `form_time_confidence` | เวลา (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 72 | `form_time_ocr_confidence` | เวลา (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 73 | `form_time_needs_review` | เวลา (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 74 | `form_time_source` | เวลา (ที่มา) | text | Raw source code (see the source table). |
| 75 | `form_time_edited` | เวลา (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 76 | `branch_raw` | สาขา (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 77 | `branch_confidence` | สาขา (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 78 | `branch_ocr_confidence` | สาขา (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 79 | `branch_needs_review` | สาขา (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 80 | `branch_source` | สาขา (ที่มา) | text | Raw source code (see the source table). |
| 81 | `branch_edited` | สาขา (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 82 | `customer_name_raw` | ชื่อลูกค้า (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 83 | `customer_name_confidence` | ชื่อลูกค้า (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 84 | `customer_name_ocr_confidence` | ชื่อลูกค้า (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 85 | `customer_name_needs_review` | ชื่อลูกค้า (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 86 | `customer_name_source` | ชื่อลูกค้า (ที่มา) | text | Raw source code (see the source table). |
| 87 | `customer_name_edited` | ชื่อลูกค้า (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 88 | `gender_raw` | เพศ (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 89 | `gender_confidence` | เพศ (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 90 | `gender_ocr_confidence` | เพศ (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 91 | `gender_needs_review` | เพศ (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 92 | `gender_source` | เพศ (ที่มา) | text | Raw source code (see the source table). |
| 93 | `gender_edited` | เพศ (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 94 | `nationality_raw` | สัญชาติ (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 95 | `nationality_confidence` | สัญชาติ (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 96 | `nationality_ocr_confidence` | สัญชาติ (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 97 | `nationality_needs_review` | สัญชาติ (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 98 | `nationality_source` | สัญชาติ (ที่มา) | text | Raw source code (see the source table). |
| 99 | `nationality_edited` | สัญชาติ (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 100 | `hotel_name_raw` | โรงแรมที่พัก (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 101 | `hotel_name_confidence` | โรงแรมที่พัก (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 102 | `hotel_name_ocr_confidence` | โรงแรมที่พัก (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 103 | `hotel_name_needs_review` | โรงแรมที่พัก (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 104 | `hotel_name_source` | โรงแรมที่พัก (ที่มา) | text | Raw source code (see the source table). |
| 105 | `hotel_name_edited` | โรงแรมที่พัก (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 106 | `referral_other_raw` | รู้จักร้านจาก: อื่น ๆ (ระบุ) (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 107 | `referral_other_confidence` | รู้จักร้านจาก: อื่น ๆ (ระบุ) (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 108 | `referral_other_ocr_confidence` | รู้จักร้านจาก: อื่น ๆ (ระบุ) (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 109 | `referral_other_needs_review` | รู้จักร้านจาก: อื่น ๆ (ระบุ) (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 110 | `referral_other_source` | รู้จักร้านจาก: อื่น ๆ (ระบุ) (ที่มา) | text | Raw source code (see the source table). |
| 111 | `referral_other_edited` | รู้จักร้านจาก: อื่น ๆ (ระบุ) (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 112 | `health_other_raw` | ภาวะสุขภาพ: อื่น ๆ (ระบุ) (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 113 | `health_other_confidence` | ภาวะสุขภาพ: อื่น ๆ (ระบุ) (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 114 | `health_other_ocr_confidence` | ภาวะสุขภาพ: อื่น ๆ (ระบุ) (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 115 | `health_other_needs_review` | ภาวะสุขภาพ: อื่น ๆ (ระบุ) (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 116 | `health_other_source` | ภาวะสุขภาพ: อื่น ๆ (ระบุ) (ที่มา) | text | Raw source code (see the source table). |
| 117 | `health_other_edited` | ภาวะสุขภาพ: อื่น ๆ (ระบุ) (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 118 | `pressure_raw` | แรงกด (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 119 | `pressure_confidence` | แรงกด (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 120 | `pressure_ocr_confidence` | แรงกด (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 121 | `pressure_needs_review` | แรงกด (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 122 | `pressure_source` | แรงกด (ที่มา) | text | Raw source code (see the source table). |
| 123 | `pressure_edited` | แรงกด (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 124 | `therapist_raw` | พนักงานนวด (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 125 | `therapist_confidence` | พนักงานนวด (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 126 | `therapist_ocr_confidence` | พนักงานนวด (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 127 | `therapist_needs_review` | พนักงานนวด (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 128 | `therapist_source` | พนักงานนวด (ที่มา) | text | Raw source code (see the source table). |
| 129 | `therapist_edited` | พนักงานนวด (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 130 | `room_raw` | ห้อง (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 131 | `room_confidence` | ห้อง (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 132 | `room_ocr_confidence` | ห้อง (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 133 | `room_needs_review` | ห้อง (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 134 | `room_source` | ห้อง (ที่มา) | text | Raw source code (see the source table). |
| 135 | `room_edited` | ห้อง (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 136 | `referral_sources_raw` | รู้จักร้านจาก (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 137 | `referral_sources_confidence` | รู้จักร้านจาก (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 138 | `referral_sources_ocr_confidence` | รู้จักร้านจาก (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 139 | `referral_sources_needs_review` | รู้จักร้านจาก (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 140 | `referral_sources_edited` | รู้จักร้านจาก (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 141 | `health_conditions_raw` | ภาวะสุขภาพ (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 142 | `health_conditions_confidence` | ภาวะสุขภาพ (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 143 | `health_conditions_ocr_confidence` | ภาวะสุขภาพ (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 144 | `health_conditions_needs_review` | ภาวะสุขภาพ (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 145 | `health_conditions_edited` | ภาวะสุขภาพ (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 146 | `massage_oil_scrub_raw` | น้ำมัน / สครับ (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 147 | `massage_oil_scrub_confidence` | น้ำมัน / สครับ (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 148 | `massage_oil_scrub_ocr_confidence` | น้ำมัน / สครับ (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 149 | `massage_oil_scrub_needs_review` | น้ำมัน / สครับ (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 150 | `massage_oil_scrub_edited` | น้ำมัน / สครับ (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 151 | `preferred_areas_raw` | จุดที่ต้องการเน้น (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 152 | `preferred_areas_confidence` | จุดที่ต้องการเน้น (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 153 | `preferred_areas_ocr_confidence` | จุดที่ต้องการเน้น (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 154 | `preferred_areas_needs_review` | จุดที่ต้องการเน้น (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 155 | `preferred_areas_edited` | จุดที่ต้องการเน้น (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 156 | `avoid_areas_raw` | จุดที่ควรหลีกเลี่ยง (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 157 | `avoid_areas_confidence` | จุดที่ควรหลีกเลี่ยง (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 158 | `avoid_areas_ocr_confidence` | จุดที่ควรหลีกเลี่ยง (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 159 | `avoid_areas_needs_review` | จุดที่ควรหลีกเลี่ยง (ต้องตรวจ) | bool | TRUE while still flagged for review. |
| 160 | `avoid_areas_edited` | จุดที่ควรหลีกเลี่ยง (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 161 | `treatment_1_raw` | ทรีตเมนต์ 1 (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 162 | `treatment_1_confidence` | ทรีตเมนต์ 1 (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 163 | `treatment_1_ocr_confidence` | ทรีตเมนต์ 1 (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 164 | `treatment_1_edited` | ทรีตเมนต์ 1 (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 165 | `treatment_1_guests` | ทรีตเมนต์ 1 (จำนวนลูกค้า) | number | Number of guests written for that treatment. |
| 166 | `treatment_2_raw` | ทรีตเมนต์ 2 (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 167 | `treatment_2_confidence` | ทรีตเมนต์ 2 (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 168 | `treatment_2_ocr_confidence` | ทรีตเมนต์ 2 (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 169 | `treatment_2_edited` | ทรีตเมนต์ 2 (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 170 | `treatment_2_guests` | ทรีตเมนต์ 2 (จำนวนลูกค้า) | number | Number of guests written for that treatment. |
| 171 | `treatment_3_raw` | ทรีตเมนต์ 3 (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 172 | `treatment_3_confidence` | ทรีตเมนต์ 3 (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 173 | `treatment_3_ocr_confidence` | ทรีตเมนต์ 3 (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 174 | `treatment_3_edited` | ทรีตเมนต์ 3 (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 175 | `treatment_3_guests` | ทรีตเมนต์ 3 (จำนวนลูกค้า) | number | Number of guests written for that treatment. |
| 176 | `treatment_4_raw` | ทรีตเมนต์ 4 (ข้อความที่ OCR อ่าน) | text | Text the OCR read (lists: the items' texts joined with `; `). |
| 177 | `treatment_4_confidence` | ทรีตเมนต์ 4 (ความมั่นใจ %) | number | Effective confidence %: 100 when staff changed or added it, else the OCR %; empty when unread or missing. |
| 178 | `treatment_4_ocr_confidence` | ทรีตเมนต์ 4 (ความมั่นใจ OCR เดิม %) | number | Original OCR %: the OCR's own confidence, kept after an edit; empty when staff added the value or the OCR had no text there. |
| 179 | `treatment_4_edited` | ทรีตเมนต์ 4 (แก้ไขโดยพนักงาน) | bool | TRUE when staff changed or added it (for a list: any item). |
| 180 | `treatment_4_guests` | ทรีตเมนต์ 4 (จำนวนลูกค้า) | number | Number of guests written for that treatment. |
<!-- columns:end -->

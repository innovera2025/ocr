# Baseline accuracy of Local AI v3.0 on real scans (2026-09-22)

Dataset: one production upload, a 95-page PDF (one Makkha intake form per page, branch SUKHUMVIT 33, clean flatbed
scans). Ground truth: all 95 pages labelled by hand from the page images (labels are not in git — they contain customer
data). Model outputs: the first 34 pages were run through Local AI v3.0 (production code) in an isolated evaluation
container on the Local AI host with the real Typhoon model; the run was stopped once the failure mode was clear.

```
pages compared: 33; local-ai totalMs median 28.9s; section patterns: {('combined',): 19, ('combined', 'staffOnlyFallback'): 2, ('combined', 'staffOnlyFallback', 'customerInformationFallback'): 9, ('combined', 'customerInformationFallback'): 3}
field                                   accuracy  wrong&flagged  wrong&UNFLAGGED
customer.name                                30%             11               12
customer.nationality                         64%              7                5
customer.hotelName                           73%              3                6
customer.gender                              64%             11                1
list.referralSources                         58%              9                5
list.healthConditions                         3%             26                6
list.massageOilScrub                          3%             21               11
list.preferredAreas                          36%             19                2
list.avoidAreas                              58%             13                1
recommendation.pressure                      15%             28                0
staff.treatmentNames                          3%             32                0
staff.treatmentsWithDuration                  3%             32                0
staff.therapist(raw-or-value)                12%             29                0
staff.room                                   76%              4                4
```

"wrong&flagged" = wrong value but needsReview=true; "wrong&UNFLAGGED" = wrong value presented as confident.

Root cause (see scan-variation-2026-09-22.md): registration corrects translation only. Real scans are ~0.7% smaller than
the calibration sample after resizing and rotated by up to −0.4°, so model crops land on the wrong region (the STAFF crop
returns room numbers or printed text, blank customer boxes produce hallucinated names) and printed checkbox borders are
counted as ticks. A scale + rotation + shift fit registers 95/95 pages (residual RMS 0.39–0.73 px).

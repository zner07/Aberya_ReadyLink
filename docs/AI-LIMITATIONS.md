# READYLINK — AI Assessment Limitations

## 1. Purpose

READYLINK uses AI-assisted assessment to provide preliminary hazard classifications and risk-level suggestions for submitted community reports. These results support initial review and prioritization; they do not replace actual inspection or verification by barangay personnel.

## 2. Gemini-Assisted Assessment

When the Gemini provider is enabled and a valid API response is received, the system sends the report description, selected hazard category, and uploaded photo when available.

Gemini returns a structured preliminary assessment containing:
- Assessment outcome
- Suggested hazard category
- Suggested risk level
- Hazard name, when the category is `Other`
- Explanation or reason for the assessment

The result depends on the information and image supplied. Incomplete, unclear, or misleading inputs may affect the assessment.

## 3. Rule-Based Fallback

When Gemini is disabled, unavailable, times out, encounters a network or API error, or returns an invalid response, READYLINK uses a deterministic rule-based fallback.

The fallback:
- Uses the report description and selected hazard category.
- Does not analyze the uploaded photo.
- Uses a fixed default risk level for each recognized category.
- Returns an `uncertain` outcome when it cannot classify the report.

The fallback risk level is not a measurement of the actual hazard severity. Reports under the same category may have different real-world severity even when the fallback assigns them the same default level.

## 4. Assessment Limitations

- AI results are preliminary suggestions, not confirmed findings.
- Image quality, lighting, camera angle, and incomplete descriptions may affect assessment quality.
- The system may misclassify hazards or fail to recognize details.
- A suggested risk level may not reflect the actual conditions at the reported location.
- The rule-based fallback does not perform image analysis or determine actual hazard severity.
- AI availability depends on provider configuration, network connectivity, API availability, and valid responses.

## 5. Human Verification

Barangay administrators must review submitted reports and verify relevant details before taking action. AI-generated results must not be treated as proof that a hazard exists or that an area is safe.

Actual field inspection and official disaster-response decisions remain the responsibility of authorized personnel.

## 6. Testing Notes

The AI integration tests cover:
- Valid Gemini responses and response validation
- Invalid Gemini responses and fallback behavior
- HTTP errors, including HTTP 503
- Network errors
- Request and response timeouts
- Unclassified reports returning an uncertain outcome

Passing these tests confirms expected software behavior under the tested conditions. It does not establish the overall accuracy of AI hazard detection in real-world situations.

---

**Project:** READYLINK  
**Prototype Area:** Barangay Alangilan, Batangas City  
**Document:** AI Assessment Limitations

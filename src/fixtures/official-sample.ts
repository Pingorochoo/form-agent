/**
 * Google Forms "official" sample form — canonical DOM snapshot fixture.
 *
 * The snapshot matches the structural shape `freebirdFormviewerViewItems` uses:
 * each question is a `.freebirdFormviewerViewItemsItem` with a title, a
 * question container, and (for choice questions) `.docssharedWizToggleLabeled`
 * label items. This doubles as the fixture DOM the Phase 1 parser is
 * regression-tested against.
 */

export const OFFICIAL_FEEDBACK_ID = 'official';
export const OFFICIAL_FEEDBACK_URL = 'https://fixtures.local/forms/official';

export async function officialSampleSnapshot(): Promise<string> {
  return `<!doctype html>
<html lang="en">
<head><title>Feedback Form</title></head>
<body>
<form role="form">
  <div class="freebirdFormviewerViewHeader">
    <div class="freebirdFormviewerViewHeaderTitleRow">
      <h1 class="freebirdFormviewerViewHeaderTitle">Feedback</h1>
    </div>
    <div class="freebirdFormviewerViewHeaderDescription">Please fill out this form. Thank you.</div>
  </div>

  <div class="freebirdFormviewerViewItemList" role="list">
    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading" aria-level="1">
        What can we do to improve?
      </div>
      <div class="freebirdFormviewerViewItemsItemRequired" role="status">*</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <div class="freebirdFormviewerViewItemsParagraphText">
          <textarea class="freebirdFormviewerViewItemsParagraphTextItem" aria-label="What can we do to improve?"></textarea>
        </div>
      </div>
    </div>
  </div>
</form>
</body>
</html>`;
}
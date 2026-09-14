/**
 * Demo harness form fixture.
 *
 * Exercises: text (short), paragraph, email-typed text, single choice,
 * multi-choice ("Other"), dropdown, linear scale, star rating, grid
 * (multiple-choice + checkbox), date, time. The Phase 1 parser must classify
 * every one of these DOM shapes.
 */

export const DEMO_FIXTURE_ID = 'demo';
export const DEMO_FIXTURE_URL = 'https://fixtures.local/forms/demo';

export async function demoSnapshot(): Promise<string> {
  return `<!doctype html>
<html lang="en">
<head><title>Demo Harness Form</title></head>
<body>
<form role="form">
  <div class="freebirdFormviewerViewHeader">
    <h1 class="freebirdFormviewerViewHeaderTitle">Demo Harness Form</h1>
    <div class="freebirdFormviewerViewHeaderDescription">Exercises every supported question kind.</div>
  </div>

  <div class="freebirdFormviewerViewItemList" role="list">

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Your name (optional)</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <input class="freebirdFormviewerViewItemsTextShort" aria-label="Your name (optional)" type="text" />
      </div>
    </div>

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Email address</div>
      <div class="freebirdFormviewerViewItemsItemRequired" role="status">*</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <input class="freebirdFormviewerViewItemsTextMail" aria-label="Email address" type="text" />
      </div>
    </div>

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Tell us about yourself</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <div class="freebirdFormviewerViewItemsParagraphText">
          <textarea class="freebirdFormviewerViewItemsParagraphTextItem" aria-label="Tell us about yourself"></textarea>
        </div>
      </div>
    </div>

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Favorite color</div>
      <div class="freebirdFormviewerViewItemsItemRequired" role="status">*</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <div class="freebirdFormviewerViewItemsItemGreyedOutRotationContainer">
          <div class="freebirdFormviewerViewItemsRadio">
            <label class="docssharedWizToggleLabeled">
              <div class="freebirdFormviewerViewItemsItemChoice"><span>Red</span></div>
            </label>
            <label class="docssharedWizToggleLabeled">
              <div class="freebirdFormviewerViewItemsItemChoice"><span>Green</span></div>
            </label>
            <label class="docssharedWizToggleLabeled">
              <div class="freebirdFormviewerViewItemsItemChoice"><span>Blue</span></div>
            </label>
            <label class="docssharedWizToggleLabeled">
              <div class="freebirdFormviewerViewItemsItemChoice"><span>Other</span></div>
              <input class="freebirdFormviewerViewItemsRadiosegmentOther" />
            </label>
          </div>
        </div>
      </div>
    </div>

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Which topics interest you? (required)</div>
      <div class="freebirdFormviewerViewItemsItemRequired" role="status">*</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <div class="freebirdFormviewerViewItemsCheckbox">
          <label class="docssharedWizToggleLabeled">
            <div class="freebirdFormviewerViewItemsItemChoice"><span>Science</span></div>
          </label>
          <label class="docssharedWizToggleLabeled">
            <div class="freebirdFormviewerViewItemsItemChoice"><span>Arts</span></div>
          </label>
          <label class="docssharedWizToggleLabeled">
            <div class="freebirdFormviewerViewItemsItemChoice"><span>Technology</span></div>
          </label>
          <label class="docssharedWizToggleLabeled">
            <div class="freebirdFormviewerViewItemsItemChoice"><span>Other</span></div>
            <input class="freebirdFormviewerViewItemsCheckboxestOther" />
          </label>
        </div>
      </div>
    </div>

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">How did you hear about us?</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <div class="freebirdFormviewerViewItemsSelect">
          <select class="freebirdFormviewerViewItemsSelect"><option>Friend</option><option>Social media</option><option>Search</option></select>
        </div>
      </div>
    </div>

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Rate your stress level</div>
      <div class="freebirdFormviewerViewItemsItemRequired" role="status">*</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <div class="freebirdFormviewerViewItemsLinearScale" aria-label="Rate your stress level"><span>Low</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>High</span></div>
      </div>
    </div>

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Star rating</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <div class="freebirdFormviewerViewItemsRating" aria-label="Star rating"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div>
      </div>
    </div>

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Team collaboration</div>
      <div class="freebirdFormviewerViewItemsItemRequired" role="status">*</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <div class="freebirdFormviewerViewItemsGrid">
          <table>
            <thead><tr><th></th><th>Strongly disagree</th><th>Disagree</th><th>Neutral</th><th>Agree</th><th>Strongly agree</th></tr></thead>
            <tbody>
              <tr><td>My team communicates effectively</td><td><label class="docssharedWizToggleLabeled">RC2</label></td><td><label class="docssharedWizToggleLabeled">RD2</label></td><td><label class="docssharedWizToggleLabeled">RN2</label></td><td><label class="docssharedWizToggleLabeled">RA2</label></td><td><label class="docssharedWizToggleLabeled">RS2</label></td></tr>
              <tr><td>We openly raise concerns</td><td><label class="docssharedWizToggleLabeled">RC3</label></td><td><label class="docssharedWizToggleLabeled">RD3</label></td><td><label class="docssharedWizToggleLabeled">RN3</label></td><td><label class="docssharedWizToggleLabeled">RA3</label></td><td><label class="docssharedWizToggleLabeled">RS3</label></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Which days work? (check all that apply)</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <div class="freebirdFormviewerViewItemsCheckboxGrid">
          <table>
            <thead><tr><th></th><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th></tr></thead>
            <tbody>
              <tr><td>Morning</td><td><label class="docssharedWizToggleLabeled">M1</label></td><td><label class="docssharedWizToggleLabeled">T1</label></td><td><label class="docssharedWizToggleLabeled">W1</label></td><td><label class="docssharedWizToggleLabeled">T2</label></td><td><label class="docssharedWizToggleLabeled">F1</label></td></tr>
              <tr><td>Afternoon</td><td><label class="docssharedWizToggleLabeled">M2</label></td><td><label class="docssharedWizToggleLabeled">T3</label></td><td><label class="docssharedWizToggleLabeled">W2</label></td><td><label class="docssharedWizToggleLabeled">T4</label></td><td><label class="docssharedWizToggleLabeled">F2</label></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">When were you born?</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <div class="freebirdFormviewerViewItemsDate" aria-label="When were you born?"><input class="freebirdFormviewerViewItemsTextShort" type="text" /></div>
      </div>
    </div>

    <div class="freebirdFormviewerViewItemsItem" role="listitem">
      <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Preferred meeting time</div>
      <div class="freebirdFormviewerViewItemsItemItem">
        <div class="freebirdFormviewerViewItemsTime" aria-label="Preferred meeting time"><input class="freebirdFormviewerViewItemsTextShort" type="text" /></div>
      </div>
    </div>

  </div>
</form>
</body>
</html>`;
}
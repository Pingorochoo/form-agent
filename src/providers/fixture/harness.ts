/**
 * Local execution harness (P5-R19, docs/PHASE_5.md "Local execution fixture/harness").
 *
 * A deterministic in-process HTTP server on loopback that serves non-sensitive
 * Google-Forms-shaped pages exercising every accepted executable answer kind
 * (text, paragraph-text, single-choice, multi-choice, linear-scale,
 * multiple-choice-grid single-select, date, time).
 *
 * It exposes explicit test-only markers (never relied on by the live Google
 * Forms provider):
 *   - data-harness-accepting        -> 'accepting' | 'closed'
 *   - data-harness-scenario         -> scenario id
 *   - data-harness-structural-version
 *   - data-harness-current-section  -> multi-section progression
 *   - data-harness-submitted        -> 'confirmed' after a successful submit
 *
 * The page embeds a real `FB_PUBLIC_LOAD_DATA_` payload so the accepted parser
 * produces the runtime `FormSchema` from `page.content()`.
 */

import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

export type HarnessScenario =
  | 'success'
  | 'closed'
  | 'mutation'
  | 'ambiguous'
  | 'locator-failure'
  | 'locator-ambiguous'
  | 'submit-missing'
  | 'submit-ambiguous'
  | 'submit-disabled'
  | 'flow';

export const HARNESS_SCENARIOS: readonly HarnessScenario[] = [
  'success',
  'closed',
  'mutation',
  'ambiguous',
  'locator-failure',
  'locator-ambiguous',
  'submit-missing',
  'submit-ambiguous',
  'submit-disabled',
  'flow',
];

export function isHarnessScenario(value: string): value is HarnessScenario {
  return (HARNESS_SCENARIOS as readonly string[]).includes(value);
}

export const HARNESS_FORM_ID = 'execution-harness';
export const HARNESS_FORM_TITLE = 'Execution Harness Survey';
export const HARNESS_FORM_DESCRIPTION = 'Non-sensitive test form for controlled execution.';

const SINGLE_SECTION_TITLE = HARNESS_FORM_TITLE;
const SINGLE_SECTION_DESCRIPTION = HARNESS_FORM_DESCRIPTION;

// ---------------------------------------------------------------------------
// Payload builders (the accepted structural source of truth for the parser).
// ---------------------------------------------------------------------------

type RawItem = unknown[];

function questionItem(id: string, title: string, type: number, group: unknown): RawItem {
  return [id, title, null, type, group];
}

function buildPayload(description: string, items: RawItem[], title: string, formIdPath: string): unknown[] {
  const form = [description, items, null, null, null, null, null, null, title];
  return [null, form, null, null, null, null, null, null, null, null, null, null, null, null, formIdPath];
}

/** The 8 executable kinds in a single section (structure A). */
function singleSectionItems(): RawItem[] {
  return [
    questionItem('q1', 'Preferred nickname', 0, [[null, null, 0, null]]),
    questionItem('q2', 'Describe your ideal workflow', 1, [[null, null, 0, null]]),
    questionItem('q3', 'Primary operating system', 2, [
      [null, [['Windows'], ['macOS'], ['Linux']], 0, null],
    ]),
    questionItem('q4', 'Which tools do you use?', 4, [
      [null, [['Editor'], ['Terminal'], ['Browser'], ['Notes']], 0, null],
    ]),
    questionItem('q5', 'Comfort with automation', 5, [
      [null, ['1', '2', '3', '4', '5'], 0, ['Low', 'High']],
    ]),
    questionItem('q6', 'Rate each tool reliability', 7, [
      [null, [['Low'], ['Medium'], ['High']], 0, ['Editor']],
      [null, [['Low'], ['Medium'], ['High']], 0, ['Terminal']],
    ]),
    questionItem('q7', 'Preferred review date', 9, [[null, null, 0, null]]),
    questionItem('q8', 'Preferred review time', 10, [[null, null, 0, null]]),
  ];
}

function singleSectionPayload(): unknown[] {
  return buildPayload(SINGLE_SECTION_DESCRIPTION, singleSectionItems(), SINGLE_SECTION_TITLE, `forms/${HARNESS_FORM_ID}`);
}

/** Mutated structure B: the same form plus one extra text question. */
function mutatedPayload(): unknown[] {
  const items = [...singleSectionItems(), questionItem('q9', 'Additional feedback', 0, [[null, null, 0, null]])];
  return buildPayload(SINGLE_SECTION_DESCRIPTION, items, SINGLE_SECTION_TITLE, `forms/${HARNESS_FORM_ID}`);
}

/** Two-section sequential form for the flow scenario. */
function flowPayload(): unknown[] {
  const items: RawItem[] = [
    ['p1', 'Section One', null, 6, null],
    questionItem('fa', 'Entry identifier', 0, [[null, null, 0, null]]),
    questionItem('fb', 'Choose a platform', 2, [[null, [['Alpha'], ['Beta']], 0, null]]),
    ['p2', 'Section Two', null, 6, null],
    questionItem('fc', 'Satisfaction level', 5, [[null, ['1', '2', '3'], 0, ['Low', 'High']]]),
    questionItem('fd', 'Final comments', 1, [[null, null, 0, null]]),
  ];
  return buildPayload('Sequential multi-section harness form.', items, 'Execution Harness Flow Form', `forms/execution-flow`);
}

function payloadJson(payload: unknown): string {
  return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// DOM renderers (accessible, non-sensitive, matched to the payload titles).
// ---------------------------------------------------------------------------

function textQuestion(title: string, kind: 'text' | 'paragraph-text'): string {
  const control =
    kind === 'paragraph-text'
      ? `<textarea class="freebirdFormviewerViewItemsParagraphTextItem" aria-label="${title}"></textarea>`
      : `<input class="freebirdFormviewerViewItemsTextShort" aria-label="${title}" type="text" />`;
  return `<div class="freebirdFormviewerViewItemsItem" role="listitem">
    <div class="freebirdFormviewerViewItemsItemTitle" role="heading">${title}</div>
    <div class="freebirdFormviewerViewItemsItemItem">${control}</div>
  </div>`;
}

function choiceQuestion(title: string, name: string, choices: string[], multi: boolean): string {
  const inputType = multi ? 'checkbox' : 'radio';
  const labels = choices
    .map((choice) => `<label class="docssharedWizToggleLabeled"><input type="${inputType}" name="${name}" value="${choice}" /> ${choice}</label>`)
    .join('');
  return `<div class="freebirdFormviewerViewItemsItem" role="listitem">
    <div class="freebirdFormviewerViewItemsItemTitle" role="heading">${title}</div>
    <div class="freebirdFormviewerViewItemsItemItem">
      <div class="freebirdFormviewerViewItems${multi ? 'Checkbox' : 'Radio'}" role="group" aria-label="${title}">${labels}</div>
    </div>
  </div>`;
}

function scaleQuestion(title: string, name: string, values: number[]): string {
  const labels = values
    .map((value) => `<label class="docssharedWizToggleLabeled"><input type="radio" name="${name}" value="${value}" /> ${value}</label>`)
    .join('');
  return `<div class="freebirdFormviewerViewItemsItem" role="listitem">
    <div class="freebirdFormviewerViewItemsItemTitle" role="heading">${title}</div>
    <div class="freebirdFormviewerViewItemsItemItem">
      <div class="freebirdFormviewerViewItemsLinearScale" role="radiogroup" aria-label="${title}">${labels}</div>
    </div>
  </div>`;
}

function gridQuestion(title: string, rows: string[], columns: string[]): string {
  const header = `<tr><th></th>${columns.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  const body = rows
    .map(
      (row, rowIndex) =>
        `<tr><td>${row}</td>${columns
          .map((column) => `<td><input type="radio" name="g${rowIndex}" value="${column}" aria-label="${column}" /></td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="freebirdFormviewerViewItemsItem" role="listitem">
    <div class="freebirdFormviewerViewItemsItemTitle" role="heading">${title}</div>
    <div class="freebirdFormviewerViewItemsItemItem">
      <div class="freebirdFormviewerViewItemsGrid" role="group" aria-label="${title}">
        <table><thead>${header}</thead><tbody>${body}</tbody></table>
      </div>
    </div>
  </div>`;
}

function dateTimeQuestion(title: string, kind: 'date' | 'time'): string {
  const cls = kind === 'date' ? 'freebirdFormviewerViewItemsDate' : 'freebirdFormviewerViewItemsTime';
  return `<div class="freebirdFormviewerViewItemsItem" role="listitem">
    <div class="freebirdFormviewerViewItemsItemTitle" role="heading">${title}</div>
    <div class="freebirdFormviewerViewItemsItemItem">
      <div class="${cls}" aria-label="${title}"><input class="freebirdFormviewerViewItemsTextShort" aria-label="${title}" type="text" /></div>
    </div>
  </div>`;
}

interface PageOptions {
  scenario: HarnessScenario;
  accepting: 'accepting' | 'closed';
  /** When true, the text control for q1 is omitted (locator failure). */
  omitNicknameControl?: boolean;
  /** When true, duplicate radios for q3 are rendered (locator ambiguity). */
  duplicateChoice?: boolean;
  /** When true, the final Submit control is omitted (submit readiness failure). */
  omitSubmit?: boolean;
  /** When true, two Submit controls are rendered (submit readiness ambiguity). */
  duplicateSubmit?: boolean;
  /** When true, the single Submit control is disabled (submit readiness failure). */
  disableSubmit?: boolean;
}

function questionBlock(options: PageOptions): string {
  const nickname =
    options.omitNicknameControl === true
      ? `<div class="freebirdFormviewerViewItemsItem" role="listitem">
           <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Preferred nickname</div>
           <div class="freebirdFormviewerViewItemsItemItem"></div>
         </div>`
      : textQuestion('Preferred nickname', 'text');

  const os =
    options.duplicateChoice === true
      ? `<div class="freebirdFormviewerViewItemsItem" role="listitem">
           <div class="freebirdFormviewerViewItemsItemTitle" role="heading">Primary operating system</div>
           <div class="freebirdFormviewerViewItemsItemItem">
             <div class="freebirdFormviewerViewItemsRadio" role="group" aria-label="Primary operating system">
               <label><input type="radio" name="q3a" value="Windows" /> Windows</label>
               <label><input type="radio" name="q3b" value="Windows" /> Windows</label>
             </div>
           </div>
         </div>`
      : choiceQuestion('Primary operating system', 'q3', ['Windows', 'macOS', 'Linux'], false);

  return [
    nickname,
    textQuestion('Describe your ideal workflow', 'paragraph-text'),
    os,
    choiceQuestion('Which tools do you use?', 'q4', ['Editor', 'Terminal', 'Browser', 'Notes'], true),
    scaleQuestion('Comfort with automation', 'q5', [1, 2, 3, 4, 5]),
    gridQuestion('Rate each tool reliability', ['Editor', 'Terminal'], ['Low', 'Medium', 'High']),
    dateTimeQuestion('Preferred review date', 'date'),
    dateTimeQuestion('Preferred review time', 'time'),
  ].join('\n');
}

function renderSingleSectionPage(payload: unknown, options: PageOptions): string {
  const mutationScript =
    options.scenario === 'mutation'
      ? `<script id="harness-mutate">
           window.__harnessMutate = function () {
             var node = document.getElementById('harness-payload');
             if (node) {
               node.textContent = 'var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(mutatedPayload())};';
             }
           };
         </script>`
      : '';

  const submitHandler =
    options.scenario === 'ambiguous'
      ? `document.body.innerHTML = '<div data-harness-submitted="ambiguous">ambiguous</div>';`
      : `document.body.innerHTML = '<div data-harness-submitted="confirmed" data-harness-confirmation="fixture:confirmed">confirmed</div>';`;

  const accepting = options.accepting;
  const disabled = accepting === 'closed' || options.disableSubmit === true ? 'disabled' : '';

  const submitControls =
    options.omitSubmit === true
      ? ''
      : options.duplicateSubmit === true
        ? `<button type="button" role="button" ${disabled}>Submit</button>
    <button type="button" role="button" ${disabled}>Submit</button>`
        : `<button type="button" role="button" ${disabled}>Submit</button>`;

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${SINGLE_SECTION_TITLE}</title></head>
<body>
<script id="harness-payload">
var FB_PUBLIC_LOAD_DATA_ = ${payloadJson(payload)};
</script>
${mutationScript}
<div data-harness-accepting="${accepting}" data-harness-scenario="${options.scenario}" data-harness-structural-version="1"></div>
<form role="form">
  <div class="freebirdFormviewerViewHeader">
    <div class="freebirdFormviewerViewHeaderTitle">${SINGLE_SECTION_TITLE}</div>
  </div>
  <div class="freebirdFormviewerViewItemList" role="list">
${questionBlock(options)}
  </div>
  <div class="freebirdFormviewerViewNavigationNavControls">
    ${submitControls}
  </div>
</form>
<script>
var submit = document.querySelector('.freebirdFormviewerViewNavigationNavControls button');
if (submit && !${accepting === 'closed'}) {
  submit.addEventListener('click', function () { ${submitHandler} });
}
</script>
</body>
</html>`;
}

function renderFlowPage(): string {
  const section1 = [
    textQuestion('Entry identifier', 'text'),
    choiceQuestion('Choose a platform', 'fb', ['Alpha', 'Beta'], false),
  ].join('\n');
  const section2 = [
    scaleQuestion('Satisfaction level', 'fc', [1, 2, 3]),
    textQuestion('Final comments', 'paragraph-text'),
  ].join('\n');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Execution Harness Flow Form</title></head>
<body>
<script id="harness-payload">
var FB_PUBLIC_LOAD_DATA_ = ${payloadJson(flowPayload())};
</script>
<div data-harness-accepting="accepting" data-harness-scenario="flow" data-harness-current-section="p1"></div>
<form role="form">
  <div class="freebirdFormviewerViewItemList" role="list">
    <div id="section-p1">${section1}</div>
    <div id="section-p2" style="display:none">${section2}</div>
  </div>
  <div class="freebirdFormviewerViewNavigationNavControls">
    <button type="button" role="button" id="next">Next</button>
    <button type="button" role="button" id="submit" style="display:none">Submit</button>
  </div>
</form>
<script>
var marker = document.querySelector('[data-harness-current-section]');
var next = document.getElementById('next');
var submit = document.getElementById('submit');
next.addEventListener('click', function () {
  document.getElementById('section-p1').style.display = 'none';
  document.getElementById('section-p2').style.display = '';
  marker.setAttribute('data-harness-current-section', 'p2');
  next.style.display = 'none';
  submit.style.display = '';
});
submit.addEventListener('click', function () {
  document.body.innerHTML = '<div data-harness-submitted="confirmed" data-harness-confirmation="fixture:flow-confirmed">confirmed</div>';
});
</script>
</body>
</html>`;
}

function pageFor(scenario: HarnessScenario): string {
  if (scenario === 'flow') return renderFlowPage();

  const options: PageOptions = { scenario, accepting: scenario === 'closed' ? 'closed' : 'accepting' };
  if (scenario === 'locator-failure') options.omitNicknameControl = true;
  if (scenario === 'locator-ambiguous') options.duplicateChoice = true;
  if (scenario === 'submit-missing') options.omitSubmit = true;
  if (scenario === 'submit-ambiguous') options.duplicateSubmit = true;
  if (scenario === 'submit-disabled') options.disableSubmit = true;
  return renderSingleSectionPage(singleSectionPayload(), options);
}

// ---------------------------------------------------------------------------
// HTTP server.
// ---------------------------------------------------------------------------

export class ExecutionHarness {
  private server: Server | null = null;
  private readonly port: number;

  constructor(port = 0) {
    this.port = port;
  }

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').replace(/^\/+/, '');
      const scenario = path.split('/')[0];
      if (scenario === undefined || !isHarnessScenario(scenario)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const html = pageFor(scenario);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });

    server.listen(this.port, '127.0.0.1');
    await once(server, 'listening');
    this.server = server;
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('harness server did not bind to a TCP port');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    server.close();
    await once(server, 'close');
  }

  urlFor(scenario: HarnessScenario): string {
    const base = this.baseUrlFor();
    return `${base}/${scenario}`;
  }

  private baseUrlFor(): string {
    if (this.server === null) throw new Error('harness not started');
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('harness not bound');
    return `http://127.0.0.1:${address.port}`;
  }
}

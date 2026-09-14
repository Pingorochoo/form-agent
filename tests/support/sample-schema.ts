/**
 * Shared typed sample schemas for domain tests.
 *
 * These are compile-checked (`satisfies FormSchema`) witnesses that the
 * FormSchema can structurally represent every kind Phase 0 requires:
 * short answer, paragraph, single/multi choice (+ Other), dropdown,
 * linear scale, rating, choice/checkbox grids, date, time, file upload,
 * unsupported, plus sections, routing, validation metadata, non-question
 * content and quiz scoring.
 *
 * `buildObservedFormSchema()` mirrors the real authorized test form observed
 * during Phase 0 (5 sections, no conditional routing). `buildRoutedSchema()`
 * is a synthetic witness that exercises the conditional-routing graph.
 */

import {
  DEFAULT_SECTION_ID,
  DOMAIN_PROVIDER_ID,
  FORMS_SCHEMA_VERSION,
  type ChoiceGridQuestion,
  type ChoiceOption,
  type DateTimeQuestion,
  type FileUploadQuestion,
  type FormSchema,
  type FormSection,
  type FreeTextQuestion,
  type LinearScaleQuestion,
  type MultiChoiceQuestion,
  type Question,
  type RatingQuestion,
  type SingleChoiceQuestion,
  type UnsupportedQuestion,
} from '../../src/domain/types.ts';

const CHECKSUM = '0'.repeat(64);

interface BaseFields {
  id: string;
  slot: number;
  title: string;
  titleThread: string;
  required: 'required' | 'optional';
  sensitive: boolean;
}

function base(
  id: string,
  slot: number,
  title: string,
  required: 'required' | 'optional' = 'optional',
): BaseFields {
  return { id, slot, title, titleThread: title, required, sensitive: false };
}

/** Aligned `choices` + `options`, appending any "Other" affordances last. */
export function buildOptions(labels: string[], otherLabels: string[] = []): ChoiceOption[] {
  return [
    ...labels.map((label) => ({ label, isOther: false })),
    ...otherLabels.map((label) => ({ label, isOther: true })),
  ];
}

function withChoices(
  labels: string[],
  otherLabels: string[] = [],
): Pick<SingleChoiceQuestion, 'choices' | 'options' | 'isOtherOpen' | 'otherLabels'> {
  const options = buildOptions(labels, otherLabels);
  return {
    choices: options.map((option) => option.label),
    options,
    isOtherOpen: otherLabels.length > 0,
    otherLabels,
  };
}

// --- one factory per representable kind -----------------------------------

export function shortAnswer(): FreeTextQuestion {
  return {
    ...base('q-name', 1, 'Nombre o código del participante', 'required'),
    kind: 'text',
    inputType: 'string',
  };
}

export function paragraph(): FreeTextQuestion {
  return {
    ...base('q-essay', 2, '¿Qué es lo que más te gusta?'),
    kind: 'paragraph-text',
    placeholder: 'Escribe aquí',
  };
}

export function singleChoice(): SingleChoiceQuestion {
  return {
    ...base('q-recommend', 3, '¿Recomendarías tu modalidad?'),
    kind: 'single-choice',
    ...withChoices(['Sí', 'No', 'Tal vez']),
    validation: { kind: 'unknown', discoverable: false },
    quiz: { points: 1, correctChoices: ['Sí'] },
  };
}

export function multiChoiceWithOther(): MultiChoiceQuestion {
  return {
    ...base('q-activities', 4, '¿Qué actividades realizas además de estudiar?'),
    kind: 'multi-choice',
    ...withChoices(['Trabajo', 'Deporte', 'Hobbies'], ['Otro']),
    maxChoices: 3,
  };
}

export function dropdown(): SingleChoiceQuestion {
  return {
    ...base('q-cycle', 5, '¿En qué ciclo académico te encuentras?', 'required'),
    kind: 'dropdown',
    ...withChoices(['1', '2', '3']),
  };
}

export function linearScale(): LinearScaleQuestion {
  return {
    ...base('q-scale', 6, '¿Cómo calificarías tu experiencia?', 'required'),
    kind: 'linear-scale',
    minLabel: 'muy malo',
    maxLabel: 'excelente',
    minValue: 1,
    maxValue: 5,
  };
}

export function ratingQuestion(): RatingQuestion {
  return {
    ...base('q-rating', 7, '¿Cómo calificarías el curso?', 'required'),
    kind: 'rating',
    style: 'star',
    maxRating: 5,
  };
}

export function choiceGrid(): ChoiceGridQuestion {
  return {
    ...base('q-grid', 8, 'Indica qué tan de acuerdo estás.'),
    kind: 'multiple-choice-grid',
    rows: [
      { id: 'q-grid.r1', label: 'Puedo concentrarme durante las clases.' },
      { id: 'q-grid.r2', label: 'Comprendo las explicaciones del docente.' },
    ],
    ...withChoices(['Totalmente en desacuerdo', 'En desacuerdo', 'De acuerdo']),
    selectionMode: 'single',
  };
}

/** Parameterized single-select grid, used to mirror the observed form. */
export function singleSelectGrid(
  id: string,
  slot: number,
  title: string,
  rowLabels: string[],
  choices: string[],
): ChoiceGridQuestion {
  return {
    ...base(id, slot, title),
    kind: 'multiple-choice-grid',
    rows: rowLabels.map((label, index) => ({ id: `${id}.r${index + 1}`, label })),
    ...withChoices(choices),
    selectionMode: 'single',
  };
}

// --- parameterized helpers (used by buildObservedFormSchema) --------------

export function textQuestion(
  id: string,
  slot: number,
  title: string,
  required: 'required' | 'optional' = 'optional',
): FreeTextQuestion {
  return { ...base(id, slot, title, required), kind: 'text', inputType: 'string' };
}

export function paragraphQuestion(
  id: string,
  slot: number,
  title: string,
  required: 'required' | 'optional' = 'optional',
): FreeTextQuestion {
  return { ...base(id, slot, title, required), kind: 'paragraph-text' };
}

export function scaleQuestion(
  id: string,
  slot: number,
  title: string,
  required: 'required' | 'optional' = 'optional',
): LinearScaleQuestion {
  return { ...base(id, slot, title, required), kind: 'linear-scale', minLabel: '', maxLabel: '', minValue: 1, maxValue: 5 };
}

export function dateOrTimeQuestion(
  id: string,
  slot: number,
  title: string,
  kind: 'date' | 'time',
  required: 'required' | 'optional' = 'optional',
): DateTimeQuestion {
  return {
    ...base(id, slot, title, required),
    kind,
    includeDate: kind === 'date',
    includeTime: true,
    includeYear: kind === 'date',
  };
}

export function multiChoiceQuestion(
  id: string,
  slot: number,
  title: string,
  choices: string[],
  required: 'required' | 'optional' = 'optional',
): MultiChoiceQuestion {
  return { ...base(id, slot, title, required), kind: 'multi-choice', ...withChoices(choices) };
}

export function singleChoiceQuestion(
  id: string,
  slot: number,
  title: string,
  choices: string[],
  required: 'required' | 'optional' = 'optional',
): SingleChoiceQuestion {
  return { ...base(id, slot, title, required), kind: 'single-choice', ...withChoices(choices) };
}

export function checkboxGrid(): ChoiceGridQuestion {
  return {
    ...base('q-cgrid', 9, '¿Qué días te acomoda?'),
    kind: 'checkbox-grid',
    rows: [
      { id: 'q-cgrid.r1', label: 'Morning' },
      { id: 'q-cgrid.r2', label: 'Afternoon' },
    ],
    ...withChoices(['Mon', 'Tue', 'Wed']),
    selectionMode: 'multi',
    otherPerRow: { 'q-cgrid.r1': false, 'q-cgrid.r2': false },
  };
}

export function dateQuestion(): DateTimeQuestion {
  return {
    ...base('q-dob', 10, 'Fecha de nacimiento', 'required'),
    kind: 'date',
    includeDate: true,
    includeTime: false,
    includeYear: true,
    validation: { kind: 'text-length', minLength: 10, maxLength: 10, discoverable: true },
  };
}

export function timeQuestion(): DateTimeQuestion {
  return {
    ...base('q-time', 11, '¿A qué hora normalmente estudias?'),
    kind: 'time',
    includeDate: false,
    includeTime: true,
    includeYear: false,
  };
}

export function fileUpload(): FileUploadQuestion {
  return {
    ...base('q-file', 12, 'Sube tu comprobante'),
    kind: 'file-upload',
    maxFileSizeMb: 10,
    maxFiles: 1,
    allowedTypes: ['application/pdf'],
    supported: false,
  };
}

export function unsupportedQuestion(): UnsupportedQuestion {
  return {
    ...base('q-unknown', 13, 'Pregunta desconocida'),
    kind: 'unsupported',
    rawTypeHint: 'google-form-item-type:99',
    reason: 'unrecognized Google Forms item type',
  };
}

/** Every representable kind, as a typed list. */
export function allQuestionKinds(): Question[] {
  return [
    shortAnswer(),
    paragraph(),
    singleChoice(),
    multiChoiceWithOther(),
    dropdown(),
    linearScale(),
    ratingQuestion(),
    choiceGrid(),
    checkboxGrid(),
    dateQuestion(),
    timeQuestion(),
    fileUpload(),
    unsupportedQuestion(),
  ];
}

// --- schema assembly ------------------------------------------------------

function section(
  id: string,
  slot: number,
  index: number,
  title: string,
  questionIds: string[],
  routing: FormSection['routing'] = { default: 'continue', conditional: false, rules: [] },
): FormSection {
  return { id, slot, index, title, questionIds, routing };
}

function assemble(questions: Question[], sections: FormSection[], formId: string): FormSchema {
  const questionSection: Record<string, string> = {};
  for (const s of sections) for (const id of s.questionIds) questionSection[id] = s.id;
  const byId: Record<string, Question> = {};
  for (const q of questions) byId[q.id] = q;
  return {
    providerId: DOMAIN_PROVIDER_ID,
    formId,
    checksum: CHECKSUM,
    schemaVersion: FORMS_SCHEMA_VERSION,
    meta: {
      url: `https://fixtures.local/forms/${formId}`,
      title: 'Phase 0 sample schema',
      capturedAt: '2026-01-01T00:00:00.000Z',
      source: 'fixture',
      requiresSignIn: false,
    },
    title: 'Phase 0 sample schema',
    parts: questions,
    definitional: sections.map((s) => ({ type: 'section' as const, id: s.id, title: s.title, slot: s.slot })),
    questions: byId,
    sections,
    questionSection,
    nonQuestionContent: [
      { type: 'text', slot: 0, title: 'Intro', text: 'Bienvenido.', ...(sections[0] ? { sectionId: sections[0].id } : {}) },
    ],
    hasRouting: sections.some((s) => s.routing.conditional),
    terminalSectionIds: sections.filter((s) => s.routing.default === 'submit').map((s) => s.id),
    rowCount: 8,
    fieldCount: questions.length,
    answerModel: 'multi-section',
  };
}

/**
 * Mirror of the observed authorized test form: 5 sections, no routing.
 *
 * Shape taken from fixtures/archives/observed-responder.structure.json (the
 * decoded real payload): 27 questions across 5 sections, four single-select
 * grids, and exactly four required questions in the final section. The real
 * form contains no dropdown / rating / file-upload / Other choice, so those are
 * covered by the synthetic witnesses (`allQuestionKinds`, `buildRoutedSchema`)
 * rather than being invented here.
 */
export function buildObservedFormSchema(): FormSchema {
  const questions: Question[] = [
    textQuestion('q-name', 0, 'Nombre o código del participante'),
    textQuestion('q-age', 1, 'Edad'),
    dateOrTimeQuestion('q-dob', 2, 'Fecha de nacimiento', 'date'),
    textQuestion('q-cycle', 3, '¿En qué ciclo académico te encuentras?'),
    textQuestion('q-modality', 4, '¿Cuál es tu modalidad principal de estudio?'),
    textQuestion('q-hours-in-person', 5, '¿Cuántas horas aproximadamente dedicas al estudio fuera de clases por semana?'),
    textQuestion('q-values', 6, '¿Qué aspectos valoras más de tus clases presenciales?'),
    scaleQuestion('q-scale-in-person', 7, '¿Cómo calificarías tu experiencia general en las clases presenciales?'),
    scaleQuestion('q-peers', 8, '¿Qué tan satisfecho estás con la interacción con tus compañeros?'),
    dateOrTimeQuestion('q-in-person-time', 9, '¿A qué hora normalmente estudias después de clases?', 'time'),
    singleSelectGrid(
      'q-grid-in-person',
      10,
      'Indica qué tan de acuerdo estás con las siguientes afirmaciones.',
      [
        'Puedo concentrarme durante las clases.',
        'Comprendo las explicaciones del docente.',
        'Participo activamente en clase.',
        'Me siento cómodo trabajando con mis compañeros.',
      ],
      ['Totalmente en desacuerdo', 'En desacuerdo', 'Ni de acuerdo ni en desacuerdo', 'De acuerdo', 'Totalmente de acuerdo'],
    ),
    textQuestion('q-hours-virtual', 11, '¿Cuántas horas aproximadamente dedicas al estudio virtual por semana?'),
    multiChoiceQuestion('q-tools', 12, '¿Qué herramientas utilizas con mayor frecuencia para estudiar?', [
      'Google Meet',
      'Zoom',
      'Google Classroom',
      'YouTube',
      'WhatsApp',
      'Documentos digitales',
    ]),
    scaleQuestion('q-scale-virtual', 13, '¿Cómo calificarías tu experiencia general con las clases virtuales?'),
    scaleQuestion('q-virtual-comms', 14, '¿Qué tan satisfecho estás con la comunicación virtual con tus compañeros?'),
    dateOrTimeQuestion('q-virtual-time', 15, '¿A qué hora normalmente realizas tus actividades virtuales?', 'time'),
    multiChoiceQuestion('q-virtual-activities', 16, 'Selecciona las actividades virtuales que realizas con frecuencia.', [
      'Ver clases grabadas',
      'Participar en videollamadas',
      'Realizar trabajos grupales',
      'Leer documentos',
      'Resolver cuestionarios',
      'Investigar información',
    ]),
    singleSelectGrid(
      'q-grid-virtual',
      17,
      'Indica qué tan de acuerdo estás con las siguientes afirmaciones.',
      [
        'Tengo facilidad para organizar mis actividades virtuales.',
        'Comprendo las indicaciones de los trabajos.',
        'Puedo mantener mi concentración.',
        'Tengo facilidad para comunicarme con mis compañeros.',
      ],
      ['Totalmente en desacuerdo', 'En desacuerdo', 'Neutral', 'De acuerdo', 'Totalmente de acuerdo'],
    ),
    textQuestion('q-sleep', 18, '¿Cuántas horas duermes aproximadamente durante un día normal?'),
    multiChoiceQuestion('q-activities', 19, '¿Qué actividades realizas además de estudiar?', [
      'Trabajo',
      'Deporte',
      'Actividades familiares',
      'Hobbies',
      'Actividades sociales',
      'Ninguna',
    ]),
    scaleQuestion('q-satisfaction-time', 20, '¿Qué tan satisfecho estás actualmente con tu organización del tiempo?'),
    singleSelectGrid(
      'q-priorities',
      21,
      'Ordena mentalmente qué aspecto consideras más importante para tener una buena experiencia académica.',
      ['Organización personal', 'Calidad docente', 'Compañeros', 'Materiales', 'Tecnología'],
      ['Muy importante', 'Importante', 'Poco importante', 'Nada importante'],
    ),
    singleSelectGrid(
      'q-satisfaction-factors',
      22,
      'Qué elementos consideras que influyen en tu satisfacción académica?',
      ['Docentes', 'Compañeros', 'Horarios', 'Infraestructura', 'Tecnología'],
      ['Motivación', 'Concentración', 'Rendimiento', 'Satisfacción'],
    ),
    paragraphQuestion('q-likes', 23, '¿Qué es lo que más te gusta de tu experiencia académica?', 'required'),
    paragraphQuestion('q-improve', 24, '¿Qué aspecto consideras que debería mejorar?', 'required'),
    paragraphQuestion('q-change', 25, 'Si pudieras cambiar una cosa de tu experiencia como estudiante, ¿Qué cambiarías?', 'required'),
    singleChoiceQuestion('q-recommend', 26, '¿Recomendarías tu modalidad de estudio a otro estudiante?', ['Sí', 'No', 'Tal vez'], 'required'),
  ];
  const sections = [
    section('s-datos', 0, 0, 'Datos generales', [
      'q-name',
      'q-age',
      'q-dob',
      'q-cycle',
      'q-modality',
    ]),
    section('s-presencial', 1, 1, 'Experiencia académica presencial sin título', [
      'q-hours-in-person',
      'q-values',
      'q-scale-in-person',
      'q-peers',
      'q-in-person-time',
      'q-grid-in-person',
    ]),
    section('s-virtual', 2, 2, 'Experiencia académica virtual', [
      'q-hours-virtual',
      'q-tools',
      'q-scale-virtual',
      'q-virtual-comms',
      'q-virtual-time',
      'q-virtual-activities',
      'q-grid-virtual',
    ]),
    section(
      's-organizacion',
      3,
      3,
      'Organización y satisfacción',
      ['q-sleep', 'q-activities', 'q-satisfaction-time', 'q-priorities', 'q-satisfaction-factors'],
    ),
    section(
      's-final',
      4,
      4,
      'Comentarios finales',
      ['q-likes', 'q-improve', 'q-change', 'q-recommend'],
      { default: 'submit', conditional: false, rules: [] },
    ),
  ];
  return assemble(questions, sections, 'observed-test-form');
}

/** Synthetic witness for conditional "go to section based on answer". */
export function buildRoutedSchema(): FormSchema {
  const questions = [singleChoice(), linearScale(), paragraph()];
  const sections = [
    section('s-modality', 0, 0, 'Modalidad', ['q-recommend'], {
      default: 'continue',
      conditional: true,
      rules: [
        { choiceLabel: 'Sí', target: 's-in-person' },
        { choiceLabel: 'No', target: 's-virtual' },
        { choiceLabel: 'Tal vez', target: 'submit' },
      ],
    }),
    section('s-in-person', 1, 1, 'Presencial', ['q-scale'], {
      default: 'submit',
      conditional: false,
      rules: [],
    }),
    section('s-virtual', 2, 2, 'Virtual', ['q-essay'], {
      default: 'submit',
      conditional: false,
      rules: [],
    }),
  ];
  return assemble(questions, sections, 'routed-sample');
}

/** A form with no explicit page breaks — one implicit section. */
export function buildSectionlessSchema(): FormSchema {
  const questions = [shortAnswer(), ratingQuestion()];
  const sections = [
    section(DEFAULT_SECTION_ID, 0, 0, '', ['q-name', 'q-rating'], {
      default: 'submit',
      conditional: false,
      rules: [],
    }),
  ];
  return assemble(questions, sections, 'sectionless');
}

// Compile-time witness: the assembled observed form must satisfy FormSchema.
export const OBSERVED_FORM_SCHEMA = buildObservedFormSchema() satisfies FormSchema;
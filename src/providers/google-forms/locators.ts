/**
 * Google Forms responder DOM locators (P5-R11).
 *
 * Isolated provider-specific locator module. Prefers resilient user-facing/
 * accessibility locators (roles, labels, accessible names) scoped to a validated
 * question container. Questions are never identified globally by title alone:
 * the orchestrator/session maps schema questions to DOM containers by accepted
 * order within the current section, and these locators operate within that
 * validated container scope.
 *
 * No `force:`-style actionability bypass. Ambiguity fails closed.
 */

import type { Locator, Page } from 'playwright';

/** Responder-page question container (matches real Google Forms + harness). */
export const QUESTION_CONTAINER_SELECTOR = '.freebirdFormviewerViewItemsItem';

/** Question title/heading inside a container. */
export const QUESTION_TITLE_SELECTOR = '.freebirdFormviewerViewItemsItemTitle';

/** Buttons that advance to the next section (localized: en/es). */
const NEXT_BUTTON_NAME = /^(next|siguiente)$/i;

/** Buttons that submit the form (localized: en/es). */
const SUBMIT_BUTTON_NAME = /^(submit|enviar|send)$/i;

/** Closed-form notice text (real Google Forms responder page). */
const CLOSED_FORM_TEXT = /no longer accepting responses|ya no acepta respuestas/i;

/** Locate every VISIBLE question container on the currently-visible page. */
export function questionContainers(page: Page): Locator {
  return page.locator(`${QUESTION_CONTAINER_SELECTOR}:visible`);
}

/** Read the normalized title/heading text of a question container. */
export async function containerTitle(container: Locator): Promise<string> {
  const title = container.locator(QUESTION_TITLE_SELECTOR).first();
  const text = await title.textContent();
  return text === null ? '' : text.trim();
}

/** The "Next" button for the current page (fails closed when absent/ambiguous). */
export function nextButton(page: Page): Locator {
  return page.getByRole('button', { name: NEXT_BUTTON_NAME });
}

/** The submit button for the current page (fails closed when absent/ambiguous). */
export function submitButton(page: Page): Locator {
  return page.getByRole('button', { name: SUBMIT_BUTTON_NAME });
}

/** Whether the page currently shows a "closed" notice (Google Forms). */
export async function pageShowsClosedNotice(page: Page): Promise<boolean> {
  return (await page.getByText(CLOSED_FORM_TEXT).count()) > 0;
}

/**
 * Whether the page shows an active supported responder control. A non-final
 * sequential section legitimately exposes Next instead of Submit, so either
 * control is evidence of an active responder section (P5-R12 / R13).
 */
export async function pageShowsResponderForm(page: Page): Promise<boolean> {
  if ((await nextButton(page).count()) > 0) return true;
  const buttons = page.getByRole('button', { name: SUBMIT_BUTTON_NAME });
  return (await buttons.count()) > 0;
}

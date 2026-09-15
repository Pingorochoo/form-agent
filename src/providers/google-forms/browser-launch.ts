/**
 * Shared Playwright browser-session opener for execution providers (P5-R19).
 *
 * Guarantees bounded, failure-safe lifecycle: if context creation, page creation,
 * or initial navigation fails after a browser has been launched, any created
 * context and the browser are closed (best-effort) and a controlled, stable
 * execution error is thrown. Raw Playwright error text / page content is never
 * exposed.
 *
 * `launch` is injectable for deterministic tests (defaults to Chromium).
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import type { ExecutionOpenOptions } from '../../domain/execution.ts';
import { EXECUTION_PRE_SUBMIT_CODES } from '../../domain/execution.ts';
import { ExecutionPreSubmitError } from '../../execution/errors.ts';

export type BrowserLauncher = (options: {
  headless: boolean;
  executablePath?: string;
}) => Promise<Browser>;

export const defaultBrowserLauncher: BrowserLauncher = (options) =>
  chromium.launch({
    headless: options.headless,
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
  });

export interface OpenedPage {
  page: Page;
  context: BrowserContext;
  browser: Browser;
}

/**
 * Launch a browser, create an isolated context/page, apply finite timeouts, and
 * run `navigate`. On any failure after launch, cleans up and throws a controlled
 * `EXECUTION_BROWSER_OPEN_FAILED` error.
 */
export async function openProviderPage(
  options: ExecutionOpenOptions,
  navigate: (page: Page) => Promise<unknown>,
  launch?: BrowserLauncher,
): Promise<OpenedPage> {
  const launcher = launch ?? defaultBrowserLauncher;
  const executablePath =
    options.executablePath !== undefined && options.executablePath !== ''
      ? options.executablePath
      : undefined;

  let browser: Browser;
  try {
    browser = await launcher({
      headless: options.headless,
      ...(executablePath !== undefined ? { executablePath } : {}),
    });
  } catch {
    throw new ExecutionPreSubmitError(
      EXECUTION_PRE_SUBMIT_CODES.BROWSER_OPEN_FAILED,
      'failed to launch the execution browser',
    );
  }

  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(options.actionTimeoutMs);
    page.setDefaultNavigationTimeout(options.navigationTimeoutMs);
    await navigate(page);
    return { page, context, browser };
  } catch {
    // Best-effort cleanup; never expose the raw failure or page content.
    if (context !== null) {
      await context.close().catch(() => {});
    }
    await browser.close().catch(() => {});
    throw new ExecutionPreSubmitError(
      EXECUTION_PRE_SUBMIT_CODES.BROWSER_OPEN_FAILED,
      'failed to open the execution browser session',
    );
  }
}

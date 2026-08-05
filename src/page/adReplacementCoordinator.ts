export interface AdReplacementCoordinatorOptions {
  maxAttempts: number;
  retryDelayMs: number;
  failureBackoffMs: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  onAttemptFailure?: (error: unknown, attempt: number) => void;
}

export class AdReplacementBackoffError extends Error {}

export class AdReplacementCoordinator<T> {
  private readonly options: AdReplacementCoordinatorOptions;
  private readonly activeRequests = new Map<string, Promise<T>>();
  private readonly retryAfter = new Map<string, number>();

  constructor(options: AdReplacementCoordinatorOptions) {
    this.options = options;
  }

  run(key: string, operation: () => Promise<T>): Promise<T> {
    const activeRequest = this.activeRequests.get(key);
    if (activeRequest) return activeRequest;

    const now = this.options.now ?? Date.now;
    const retryAfter = this.retryAfter.get(key) ?? 0;
    if (now() < retryAfter) {
      return Promise.reject(
        new AdReplacementBackoffError(
          `Waiting until ${new Date(retryAfter).toISOString()} to retry ad replacement.`
        )
      );
    }

    const request = this.runWithRetry(operation)
      .then(result => {
        this.retryAfter.delete(key);
        return result;
      })
      .catch(error => {
        this.retryAfter.set(key, now() + this.options.failureBackoffMs);
        throw error;
      })
      .finally(() => {
        this.activeRequests.delete(key);
      });
    this.activeRequests.set(key, request);
    return request;
  }

  private async runWithRetry(operation: () => Promise<T>): Promise<T> {
    const sleep =
      this.options.sleep ??
      ((delayMs: number) =>
        new Promise<void>(resolve => setTimeout(resolve, delayMs)));

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        this.options.onAttemptFailure?.(error, attempt);
        if (attempt === this.options.maxAttempts) throw error;
        await sleep(this.options.retryDelayMs);
      }
    }

    throw new Error("Ad replacement attempt limit must be greater than zero.");
  }
}

interface HandleDetectedAdOptions<T> {
  coordinator: AdReplacementCoordinator<T>;
  key: string;
  replace: () => Promise<T>;
  onReplacement: (replacement: T) => void;
  onFailure: (error: unknown) => void;
  cancelRequest: () => never;
}

export async function handleDetectedAd<T>(
  options: HandleDetectedAdOptions<T>
): Promise<T> {
  try {
    const replacement = await options.coordinator.run(
      options.key,
      options.replace
    );
    options.onReplacement(replacement);
    return replacement;
  } catch (error) {
    if (!(error instanceof AdReplacementBackoffError)) {
      try {
        options.onFailure(error);
      } catch {}
    }
    return options.cancelRequest();
  }
}

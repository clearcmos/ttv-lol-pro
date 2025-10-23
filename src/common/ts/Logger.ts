export default class Logger {
  #prefix = "[TTV LOL PRO]";

  constructor(context?: string) {
    if (context) {
      this.#prefix = `[TTV LOL PRO] (${context})`;
    }
  }

  log(...data: any[]) {
    console.log(this.#prefix, ...data);
  }

  warn(...data: any[]) {
    console.warn(this.#prefix, ...data);
  }

  error(...data: any[]) {
    console.error(this.#prefix, ...data);
  }

  debug(...data: any[]) {
    if (process.env.NODE_ENV === "development") {
      console.debug(this.#prefix, ...data);
    }
  }
}

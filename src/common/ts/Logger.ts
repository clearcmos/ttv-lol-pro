export default class Logger {
  private readonly _prefix: string;

  constructor(context?: string) {
    this._prefix = context ? `[TTV LOL PRO] (${context})` : "[TTV LOL PRO]";
  }

  log(...data: any[]) {
    console.log(this._prefix, ...data);
  }

  warn(...data: any[]) {
    console.warn(this._prefix, ...data);
  }

  error(...data: any[]) {
    console.error(this._prefix, ...data);
  }

  debug(...data: any[]) {
    if (process.env.NODE_ENV === "development") {
      console.debug(this._prefix, ...data);
    }
  }
}

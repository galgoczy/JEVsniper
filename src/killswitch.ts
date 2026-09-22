import fs from "node:fs";

/** STOP fájl a projekt gyökerében: nincs új belépés, kilépések futnak. */
export const STOP_FILE = process.env.STOP_FILE ?? "STOP";
export const stopFileExists = () => fs.existsSync(STOP_FILE);
export const createStopFile = (reason: string) => fs.writeFileSync(STOP_FILE, `${new Date().toISOString()} ${reason}\n`);
export const removeStopFile = () => { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); };

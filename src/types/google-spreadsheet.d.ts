/**
 * Минимальные объявления типов для google-spreadsheet v3.
 * Официальные типы отсутствуют в этой версии пакета.
 */
declare module "google-spreadsheet" {
  export type CellValue = string | number | boolean | Date | null;

  export type TextFormat = {
    fontFamily?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    fontSize?: number;
    foregroundColor?: Color;
    foregroundColorStyle?: unknown;
  };

  export type Color = {
    red?: number;
    green?: number;
    blue?: number;
    alpha?: number;
  };

  export type CellAlignment = "LEFT" | "CENTER" | "RIGHT" | null;

  export type GoogleSpreadsheetCell = {
    value: CellValue;
    textFormat: TextFormat;
    backgroundColor: Color | undefined;
    horizontalAlignment: CellAlignment;
    verticalAlignment: CellAlignment;
    numberValue?: number | null;
    stringValue?: string | null;
    boolValue?: boolean | null;
    formulaValue?: string | null;
    note?: string;
    save(): Promise<void>;
  };

  export type GoogleSpreadsheetWorksheet = {
    title: string;
    sheetId: number;
    rowCount: number;
    columnCount: number;
    loadCells(filters?: unknown): Promise<void>;
    saveUpdatedCells(): Promise<void>;
    saveCells(cells: GoogleSpreadsheetCell[]): Promise<void>;
    getCell(row: number, col: number): GoogleSpreadsheetCell;
    getCells(filters?: unknown): Promise<GoogleSpreadsheetCell[]>;
    addRow(values: unknown): Promise<unknown>;
    setHeaderRow(values: string[]): Promise<void>;
    clear(): Promise<void>;
  };

  export class GoogleSpreadsheet {
    constructor(sheetId: string);
    sheetsById: { [key: string]: GoogleSpreadsheetWorksheet };
    useServiceAccountAuth(creds: unknown): Promise<void>;
    loadInfo(): Promise<void>;
    getTitle(): Promise<string>;
  }
}


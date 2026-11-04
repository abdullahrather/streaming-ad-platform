/**
 * src/modules/reports/reports.export.ts
 *
 * Turns a report into CSV or PDF. Both show the same rows, columns and totals.
 */
import PDFDocument from 'pdfkit';
import { env } from '@/config/env';
import type { ReportGrouping } from '@prisma/client';
import type { ReportColumn } from './reports.schema';
import type { ReportResult, ReportValues } from './reports.service';

export const COLUMN_LABELS: Record<ReportColumn, string> = {
  impressions: 'Impressions',
  clicks: 'Clicks',
  ctr: 'CTR (%)',
  firstQuartileRate: 'Reached 25% (%)',
  midpointRate: 'Reached 50% (%)',
  thirdQuartileRate: 'Reached 75% (%)',
  completions: 'Completions',
  completionRate: 'Completion rate (%)',
  spend: 'Spend (€)',
  ecpm: 'eCPM (€)',
  reach: 'Reach',
  averageFrequency: 'Average frequency',
};

export const GROUPING_LABELS: Record<ReportGrouping, string> = {
  DAY: 'Day',
  CAMPAIGN: 'Campaign',
  SLOT: 'Ad slot',
  COUNTRY: 'Country',
  DEVICE: 'Device',
  SHOW: 'Show',
};

const DECIMALS: Record<ReportColumn, number> = {
  impressions: 0,
  clicks: 0,
  ctr: 2,
  firstQuartileRate: 1,
  midpointRate: 1,
  thirdQuartileRate: 1,
  completions: 0,
  completionRate: 1,
  spend: 2,
  ecpm: 2,
  reach: 0,
  averageFrequency: 2,
};

const plain = (column: ReportColumn, value: number | undefined): string =>
  (value ?? 0).toFixed(DECIMALS[column]);

const pretty = (column: ReportColumn, value: number | undefined): string =>
  (value ?? 0).toLocaleString('en-GB', {
    minimumFractionDigits: DECIMALS[column],
    maximumFractionDigits: DECIMALS[column],
  });

const moment = new Intl.DateTimeFormat('en-GB', {
  timeZone: env.PLATFORM_TIMEZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** A report covers a rolling window up to the current hour, so the label shows times. */
export const periodLabel = ({ from, to }: Pick<ReportResult, 'from' | 'to'>): string =>
  `${moment.format(from)} to ${moment.format(to)}`;

/** Spreadsheets run cells starting with these as formulas, so they're made plain text. */
const safeCell = (text: string): string => {
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
};

const rowLabel = (row: { key: string; label: string }): string => row.label || row.key;

export const toCsv = (report: ReportResult): string => {
  const header = [GROUPING_LABELS[report.groupBy], ...report.columns.map((c) => COLUMN_LABELS[c])];
  const line = (label: string, values: ReportValues): string =>
    [safeCell(label), ...report.columns.map((column) => plain(column, values[column]))].join(',');

  return [
    header.map(safeCell).join(','),
    ...report.rows.map((row) => line(rowLabel(row), row.values)),
    line('Total', report.totals),
  ].join('\r\n');
};

export interface PdfMeta {
  title: string;
  organisation: string;
  generatedAt: Date;
}

const PAGE = { margin: 40, rowHeight: 18, firstColumn: 170 };

export const toPdf = (report: ReportResult, meta: PdfMeta): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: PAGE.margin });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.info.Title = meta.title;
    const width = doc.page.width - PAGE.margin * 2;
    const valueWidth = (width - PAGE.firstColumn) / Math.max(1, report.columns.length);
    const bottom = doc.page.height - PAGE.margin - PAGE.rowHeight;

    doc.font('Helvetica-Bold').fontSize(16).text(meta.title);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#555555')
      .text(
        `${meta.organisation} · ${periodLabel(report)} · by ${GROUPING_LABELS[report.groupBy].toLowerCase()} · ` +
          `generated ${moment.format(meta.generatedAt)} · times in ${env.PLATFORM_TIMEZONE}`,
      )
      .fillColor('#000000')
      .moveDown(1);

    const drawRow = (cells: string[], bold: boolean, shaded: boolean): void => {
      if (doc.y > bottom) doc.addPage();
      const y = doc.y;
      if (shaded)
        doc
          .rect(PAGE.margin, y - 3, width, PAGE.rowHeight)
          .fill('#f1f3f5')
          .fillColor('#000000');
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      doc.text(cells[0] ?? '', PAGE.margin + 4, y, {
        width: PAGE.firstColumn - 8,
        lineBreak: false,
        ellipsis: true,
      });
      cells.slice(1).forEach((cell, index) => {
        doc.text(cell, PAGE.margin + PAGE.firstColumn + index * valueWidth, y, {
          width: valueWidth - 6,
          align: 'right',
          lineBreak: false,
        });
      });
      doc.x = PAGE.margin;
      doc.y = y + PAGE.rowHeight;
    };

    const header = [
      GROUPING_LABELS[report.groupBy],
      ...report.columns.map((c) => COLUMN_LABELS[c]),
    ];
    drawRow(header, true, true);
    doc.on('pageAdded', () => drawRow(header, true, true));

    if (report.rows.length === 0) {
      doc
        .font('Helvetica')
        .fontSize(10)
        .text('No delivery in this period.', PAGE.margin, doc.y + 6);
    }
    report.rows.forEach((row, index) =>
      drawRow(
        [rowLabel(row), ...report.columns.map((c) => pretty(c, row.values[c]))],
        false,
        index % 2 === 1,
      ),
    );
    drawRow(['Total', ...report.columns.map((c) => pretty(c, report.totals[c]))], true, true);

    doc.end();
  });

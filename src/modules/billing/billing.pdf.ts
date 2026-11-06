/**
 * src/modules/billing/billing.pdf.ts
 *
 * An invoice as a one-page PDF, built from the invoice row alone, so it reads the same
 * after the campaign is renamed or deleted.
 */
import type { Invoice } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { env } from '@/config/env';

const SELLER = 'Campaign Analytics';
const MARGIN = 50;

const euros = (cents: number): string =>
  `€${(cents / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const day = (date: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: env.PLATFORM_TIMEZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);

export const invoicePdf = (invoice: Invoice): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.info.Title = `Invoice ${invoice.number}`;
    const width = doc.page.width - MARGIN * 2;

    doc.font('Helvetica-Bold').fontSize(20).text('Invoice');
    doc.font('Helvetica').fontSize(10).fillColor('#555555');
    doc.text(`${invoice.number} · issued ${day(invoice.issuedAt)}`).moveDown(1.5);

    const top = doc.y;
    doc.fillColor('#000000').font('Helvetica-Bold').text('From', MARGIN, top);
    doc.font('Helvetica').text(SELLER);
    doc.font('Helvetica-Bold').text('Bill to', MARGIN + width / 2, top);
    doc.font('Helvetica').text(invoice.organisationName, MARGIN + width / 2);
    doc.x = MARGIN;
    doc.moveDown(2);

    // One line: the campaign's delivered impressions at their average price.
    const columns = [
      { label: 'Description', x: MARGIN, width: width * 0.5, align: 'left' as const },
      {
        label: 'Impressions',
        x: MARGIN + width * 0.5,
        width: width * 0.17,
        align: 'right' as const,
      },
      {
        label: 'Average CPM',
        x: MARGIN + width * 0.67,
        width: width * 0.16,
        align: 'right' as const,
      },
      { label: 'Amount', x: MARGIN + width * 0.83, width: width * 0.17, align: 'right' as const },
    ];
    const row = (cells: string[], bold = false): void => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
      let height = 0;
      columns.forEach((column, index) => {
        doc.text(cells[index] ?? '', column.x, y, { width: column.width - 6, align: column.align });
        height = Math.max(height, doc.y - y);
      });
      doc.x = MARGIN;
      doc.y = y + height + 8;
    };

    const header = doc.y;
    doc
      .rect(MARGIN, header - 4, width, 20)
      .fill('#f1f3f5')
      .fillColor('#000000');
    row(
      columns.map(({ label }) => label),
      true,
    );
    const averageCpm =
      invoice.impressions > 0
        ? Math.round((invoice.subtotalCents / invoice.impressions) * 1000)
        : 0;
    row([
      `Video ad impressions: “${invoice.campaignTitle}” for ${invoice.advertiser}, ${day(invoice.periodStart)} to ${day(invoice.periodEnd)}`,
      invoice.impressions.toLocaleString('en-GB'),
      euros(averageCpm),
      euros(invoice.subtotalCents),
    ]);

    doc
      .moveTo(MARGIN, doc.y)
      .lineTo(MARGIN + width, doc.y)
      .strokeColor('#cccccc')
      .stroke();
    doc.moveDown(0.5);
    if (invoice.taxCents > 0) {
      row(['Subtotal', '', '', euros(invoice.subtotalCents)]);
      row(['VAT', '', '', euros(invoice.taxCents)]);
    }
    row(['Total', '', '', euros(invoice.totalCents)], true);

    doc.moveDown(1.5).font('Helvetica').fontSize(9).fillColor('#555555');
    doc.text(`Paid from your prepaid balance on ${day(invoice.issuedAt)}. Nothing more is due.`);
    if (invoice.taxCents === 0) doc.text('Amounts are net.');
    doc.text(
      `Clicks: ${invoice.clicks.toLocaleString('en-GB')}. ` +
        (invoice.filteredEvents > 0
          ? `${invoice.filteredEvents.toLocaleString('en-GB')} events were removed as invalid traffic and not billed.`
          : 'No invalid traffic was removed.'),
    );
    doc.text(`Dates in ${env.PLATFORM_TIMEZONE}. Amounts in ${invoice.currency}.`);

    doc.end();
  });

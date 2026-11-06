/**
 * src/modules/billing/billing.pdf.ts
 *
 * An invoice as a one-page PDF, built from the invoice row alone, so it reads the same
 * after the campaign is renamed or deleted, or the seller's details change.
 */
import type { Invoice } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { env } from '@/config/env';

const MARGIN = 50;

const money = (cents: number, currency: string): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(cents / 100);

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

    const currency = invoice.currency;
    const inEuros = currency === 'EUR';
    doc.info.Title = `Invoice ${invoice.number}`;
    const width = doc.page.width - MARGIN * 2;

    doc.font('Helvetica-Bold').fontSize(20).text('Invoice');
    doc.font('Helvetica').fontSize(10).fillColor('#555555');
    doc.text(`${invoice.number} · issued ${day(invoice.issuedAt)}`).moveDown(1.5);

    // Seller and buyer, side by side, as they were when the invoice was issued.
    const party = (title: string, lines: string[], x: number, top: number): number => {
      doc
        .fillColor('#000000')
        .font('Helvetica-Bold')
        .text(title, x, top, { width: width / 2 - 10 });
      doc.font('Helvetica');
      for (const line of lines.filter(Boolean)) doc.text(line, x, doc.y, { width: width / 2 - 10 });
      return doc.y;
    };
    const top = doc.y;
    const left = party(
      'From',
      [
        invoice.sellerName,
        ...invoice.sellerAddress.split(', '),
        invoice.sellerVatId ? `VAT ID ${invoice.sellerVatId}` : '',
      ],
      MARGIN,
      top,
    );
    const right = party(
      'Bill to',
      [
        invoice.organisationName,
        ...invoice.buyerAddress.split('\n'),
        invoice.buyerVatId ? `VAT ID ${invoice.buyerVatId}` : '',
      ],
      MARGIN + width / 2,
      top,
    );
    doc.x = MARGIN;
    doc.y = Math.max(left, right) + 24;

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
      money(averageCpm, currency),
      money(invoice.subtotalCents, currency),
    ]);

    doc
      .moveTo(MARGIN, doc.y)
      .lineTo(MARGIN + width, doc.y)
      .strokeColor('#cccccc')
      .stroke();
    doc.moveDown(0.5);
    row(['Net amount', '', '', money(invoice.subtotalCents, currency)]);
    row([`VAT ${invoice.vatRateBp / 100}%`, '', '', money(invoice.taxCents, currency)]);
    row(['Total', '', '', money(invoice.totalCents, currency)], true);

    doc.moveDown(1.5).font('Helvetica').fontSize(9).fillColor('#555555');
    if (invoice.vatNote) doc.text(invoice.vatNote);
    if (!inEuros) {
      // The VAT must also be stated in euros, the currency of the country where it's due.
      doc.text(
        `Exchange rate: 1 EUR = ${Number(invoice.exchangeRate).toFixed(4)} ${currency}, the European Central Bank reference rate. ` +
          `In euros: net ${money(invoice.eurSubtotalCents, 'EUR')}, VAT ${money(invoice.eurTaxCents, 'EUR')}, total ${money(invoice.eurTotalCents, 'EUR')}.`,
      );
    }
    doc.text(`Paid from your prepaid balance on ${day(invoice.issuedAt)}. Nothing more is due.`);
    doc.text(
      `Clicks: ${invoice.clicks.toLocaleString('en-GB')}. ` +
        (invoice.filteredEvents > 0
          ? `${invoice.filteredEvents.toLocaleString('en-GB')} events were removed as invalid traffic and not billed.`
          : 'No invalid traffic was removed.'),
    );
    doc.text(`Dates in ${env.PLATFORM_TIMEZONE}.`);

    doc.end();
  });

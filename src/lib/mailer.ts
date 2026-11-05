/**
 * src/lib/mailer.ts
 *
 * Sends email through SMTP_URL when it's set. Without it, development keeps
 * messages in a local mailbox, so nothing needs configuring to try the flows.
 */
import nodemailer from 'nodemailer';
import { prisma } from '@/lib/prisma';
import { env } from '@/config/env';

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface Email {
  to: string;
  subject: string;
  body: string;
  link?: string;
  attachments?: Attachment[];
}

export const usesLocalMailbox = (): boolean => !env.SMTP_URL && env.NODE_ENV !== 'production';

const transport = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;

const deliver = async ({
  to,
  subject,
  body,
  link = '',
  attachments = [],
}: Email): Promise<void> => {
  if (transport) {
    const text = link ? `${body}\n\n${link}` : body;
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text, attachments });
    return;
  }

  if (usesLocalMailbox()) {
    const files = attachments.map(({ filename, contentType, content }) => ({
      filename,
      contentType,
      content: content.toString('base64'),
    }));
    await prisma.capturedEmail.create({
      data: { recipient: to, subject, body, link, attachments: files },
    });
    return;
  }

  console.warn(`Email to ${to} was not sent: SMTP_URL is not set.`);
};

/** Sends and waits, for scheduled jobs that need to know the email went out. */
export const deliverEmail = deliver;

/**
 * Sends in the background. Waiting would let response time reveal whether an
 * address has an account, and a mail problem shouldn't fail the request.
 */
export const sendEmail = (email: Email): void => {
  deliver(email).catch((error: unknown) => console.error('Email failed:', String(error)));
};

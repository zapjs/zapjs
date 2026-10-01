'use server';
import { cookies } from '@zap-js/client/server';
export async function save(previous: string, form: FormData): Promise<string> {
  const name = String(form.get('name') ?? '').trim();
  if (!name || name.length > 100) throw new Error('Name must contain 1 to 100 characters');
  cookies().set('zap-name', name, { httpOnly: true, sameSite: 'lax', secure: false });
  return `Saved ${name}`;
}

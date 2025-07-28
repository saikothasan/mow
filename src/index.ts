export interface Env {
    TEMP_MAIL_DOMAIN: string;
    EMAIL_MAP: KVNamespace;
    API_KEY?: string;
}

interface EmailAddress {
    username: string;
    domain: string;
}

interface Email {
    id: string;
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    receivedAt: number;
}

interface AddressData {
    address: string;
    expiresAt: number;
    emails: Email[];
}

interface CreateAddressResponse {
    address: string;
    expiresAt: number;
}

interface ErrorResponse {
    error: string;
}

function parseEmailAddress(email: string): EmailAddress | null {
    const parts = email.split('@');
    if (parts.length !== 2) return null;
    return { username: parts[0], domain: parts[1] };
}

function generateRandomString(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function validateApiKey(request: Request, env: Env): boolean {
    if (!env.API_KEY) return true; // No API key required if not set
    const apiKey = request.headers.get('X-API-KEY');
    return apiKey === env.API_KEY;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // CORS headers
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, X-API-KEY',
        };

        if (method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // Validate API key for all endpoints except webhook
        if (path !== '/webhook' && !validateApiKey(request, env)) {
            return Response.json({ error: 'Invalid API key' }, { 
                status: 401,
                headers: corsHeaders
            });
        }

        try {
            // Create new temp email address
            if (method === 'POST' && path === '/address') {
                const { ttl = 3600 } = await request.json<{ ttl?: number }>();
                const username = generateRandomString(12);
                const address = `${username}@${env.TEMP_MAIL_DOMAIN}`;
                const expiresAt = Math.floor(Date.now() / 1000) + ttl;

                const addressData: AddressData = {
                    address,
                    expiresAt,
                    emails: []
                };

                await env.EMAIL_MAP.put(username, JSON.stringify(addressData), { 
                    expiration: expiresAt 
                });

                const response: CreateAddressResponse = { address, expiresAt };
                return Response.json(response, { headers: corsHeaders });
            }

            // Check emails for an address
            if (method === 'GET' && path.startsWith('/address/')) {
                const username = path.split('/')[2];
                if (!username) {
                    throw new Error('Username is required');
                }

                const data = await env.EMAIL_MAP.get(username);
                if (!data) {
                    throw new Error('Address not found');
                }

                const addressData = JSON.parse(data) as AddressData;
                return Response.json(addressData, { headers: corsHeaders });
            }

            // Delete an address and its emails
            if (method === 'DELETE' && path.startsWith('/address/')) {
                const username = path.split('/')[2];
                if (!username) {
                    throw new Error('Username is required');
                }

                await env.EMAIL_MAP.delete(username);
                return new Response(null, { 
                    status: 204, 
                    headers: corsHeaders 
                });
            }

            // Webhook endpoint for Cloudflare Email Routing
            if (method === 'POST' && path === '/webhook') {
                const formData = await request.formData();
                const from = formData.get('from') as string;
                const to = formData.get('to') as string;
                const subject = formData.get('subject') as string;
                const text = formData.get('text') as string;
                const html = formData.get('html') as string;

                const parsedTo = parseEmailAddress(to);
                if (!parsedTo || parsedTo.domain !== env.TEMP_MAIL_DOMAIN) {
                    return new Response('Invalid recipient', { status: 400 });
                }

                const username = parsedTo.username;
                const data = await env.EMAIL_MAP.get(username);
                if (!data) {
                    return new Response('Address not found', { status: 404 });
                }

                const addressData = JSON.parse(data) as AddressData;
                const email: Email = {
                    id: generateRandomString(16),
                    from,
                    to,
                    subject: subject || '(No subject)',
                    text: text || '(No text content)',
                    html: html || (text ? `<p>${text}</p>` : '<p>(No content)</p>'),
                    receivedAt: Math.floor(Date.now() / 1000)
                };

                // Store only the 50 most recent emails to prevent overloading KV
                addressData.emails.unshift(email);
                if (addressData.emails.length > 50) {
                    addressData.emails = addressData.emails.slice(0, 50);
                }

                await env.EMAIL_MAP.put(username, JSON.stringify(addressData));

                return new Response('Email stored', { status: 200 });
            }

            return new Response('Not Found', { status: 404 });
        } catch (error) {
            const response: ErrorResponse = { 
                error: error instanceof Error ? error.message : 'Unknown error' 
            };
            return Response.json(response, { 
                status: 400, 
                headers: corsHeaders 
            });
        }
    },
};

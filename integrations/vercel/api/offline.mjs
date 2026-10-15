// Prepared frontend-only deployment boundary. No database, proxy or provider calls.
export default function offlineApi(_request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.status(503).json({
    error: {
      code: 'hosted_api_not_available',
      message: 'This deployment contains the interface only. Use the local Refund Office service for cases, review and simulated payments.',
    },
  });
}

export function BadRequestResponse() {
  return new Response(JSON.stringify({
    success: false,
    code: 400,
    message: 'Bad Request',
    error: 'Invalid Request',
  }), { status: 400, headers: { 'Content-Type': 'application/json' } })
}

export function UnprocessableEntityResponse() {
  return new Response(JSON.stringify({
    success: false,
    code: 422,
    message: 'Unprocessable Entity',
    error: 'Invalid Request',
  }), { status: 422, headers: { 'Content-Type': 'application/json' } })
}

export function InternalServerErrorResponse() {
  return new Response(JSON.stringify({
    success: false,
    code: 500,
    message: 'Internal Server Error',
    error: undefined,
  }), { status: 500, headers: { 'Content-Type': 'application/json' } })
}

// > "/api/2/envelope/".split('/')
//   [ '', 'api', '2', 'envelope', '' ]
export function extractProjectIDFromPathname(pathname: string) {
  const parts = pathname.split('/')
  if (parts.length < 4) return null
  return parts[2]
}

export function safeJSONObjectParse<T>(json: string): Partial<T> {
  try {
    return JSON.parse(json) as T
  } catch (error) {
    return {}
  }
}

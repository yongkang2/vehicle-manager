export const ATTACHMENT_BATCH_LIMIT = 8
export const ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024
export const ATTACHMENT_EXTENSIONS = ['.xlsx', '.xls', '.pdf', '.png', '.jpg', '.jpeg', '.jfif'] as const

export function attachmentFileError(file: Pick<File, 'name' | 'size'>): 'FILE_TYPE_NOT_ALLOWED' | 'FILE_TOO_LARGE' | undefined {
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
  if (!ATTACHMENT_EXTENSIONS.some(value => value === extension)) return 'FILE_TYPE_NOT_ALLOWED'
  if (file.size > ATTACHMENT_MAX_FILE_BYTES) return 'FILE_TOO_LARGE'
}

import { MethodCallArgs } from './MethodCallArgs'
import { HTTPError } from '../Errors'

export { MethodCallArgs } from './MethodCallArgs'
export { HTTPCodes } from './HTTPCodes'

export interface WebDAVRequest
{
    (arg : MethodCallArgs, callback : () => void) : void

    chunked ?: (arg : MethodCallArgs, callback : () => void) => void
}

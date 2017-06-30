import { HTTPAuthentication } from './HTTPAuthentication';
import { HTTPRequestContext } from '../../../server/v2/RequestContext';
import { IListUserManager } from '../userManager/IListUserManager';
import { IUser } from '../IUser';
export declare class HTTPDigestAuthentication implements HTTPAuthentication {
    userManager: IListUserManager;
    realm: string;
    nonceSize: number;
    constructor(userManager: IListUserManager, realm?: string, nonceSize?: number);
    generateNonce(): string;
    askForAuthentication(): {
        'WWW-Authenticate': string;
    };
    getUser(arg: HTTPRequestContext, callback: (error: Error, user: IUser) => void): void;
}

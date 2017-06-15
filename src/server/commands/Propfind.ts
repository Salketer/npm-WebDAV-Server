import { HTTPCodes, MethodCallArgs, WebDAVRequest } from '../WebDAVRequest'
import { IResource, ETag, ReturnCallback } from '../../resource/IResource'
import { XML, XMLElement } from '../../helper/XML'
import { BasicPrivilege } from '../../user/privilege/IPrivilegeManager'
import { Workflow } from '../../helper/Workflow'
import { FSPath } from '../../manager/FSPath'
import { Errors } from '../../Errors'
import { Lock } from '../../resource/lock/Lock'
import * as http from 'http'

function lockDiscovery(lockDiscoveryCache : any, arg : MethodCallArgs, path : FSPath, resource : IResource, callback : ReturnCallback<any>)
{
    const cached = lockDiscoveryCache[path.toString()];
    if(cached)
    {
        callback(null, cached);
        return;
    }

    const _Callback = callback;
    callback = (e, l) => {
        if(!e)
            lockDiscoveryCache[path.toString()] = l;
        _Callback(e, l);
    }

    arg.requireErPrivilege('canListLocks', resource, (e, can) => {
        if(e || !can)
        {
            callback(e, {});
            return;
        }

        resource.getLocks((e, locks) => {
            if(resource.parent)
            {
                const parentPath = path.getParent();
                lockDiscovery(lockDiscoveryCache, arg, parentPath, resource.parent, (e, l) => {
                    if(e)
                        callback(e, null);
                    else
                    {
                        l[path.toString()] = locks;
                        callback(null, l);
                    }
                });
            }
            else
                callback(null, {
                    [path.toString()]: locks
                });
        });
    })
}

interface PropertyRule
{
    leftElements : XMLElement[]
    mustDisplay : (propertyName : string) => boolean
    mustDisplayValue : (propertyName : string) => boolean
}

function parseRequestBody(arg : MethodCallArgs) : PropertyRule
{
    const allTrue : PropertyRule = {
        leftElements: [],
        mustDisplay: () => true,
        mustDisplayValue: () => true
    }
    const onlyName : PropertyRule = {
        leftElements: [],
        mustDisplay: () => true,
        mustDisplayValue: () => false
    }

    if(arg.contentLength <= 0)
        return allTrue;

    try
    {
        const xml = XML.parse(arg.data);

        const propfind = xml.find('DAV:propfind');

        if(propfind.findIndex('DAV:propname') !== -1)
            return onlyName;

        if(propfind.findIndex('DAV:allprop') !== -1)
            return allTrue;

        const prop = propfind.find('DAV:prop');
        const fn = (name : string) => {
            const index = prop.findIndex(name);
            if(index === -1)
                return false;
            delete prop.elements[index];
            return true;
        };

        return {
            leftElements: prop.elements,
            mustDisplay: fn,
            mustDisplayValue: () => true
        }
    }
    catch(ex)
    {
        return allTrue;
    }
}

function propstatStatus(status : number)
{
    return 'HTTP/1.1 ' + status + ' ' + http.STATUS_CODES[status];
}

export default function(arg : MethodCallArgs, callback)
{
    arg.getResource((e, resource) => {
        if(e || !resource)
        {
            arg.setCode(HTTPCodes.NotFound);
            callback();
            return;
        }

        const lockDiscoveryCache = {};

        arg.checkIfHeader(resource, () => {
            const targetSource = arg.isSource;

            const multistatus = XML.createElement('D:multistatus', {
                'xmlns:D': 'DAV:'
            })

            resource.type((e, type) => process.nextTick(() => {
                if(!type.isDirectory || arg.depth === 0)
                {
                    addXMLInfo(resource, multistatus, (e) => {
                        if(!e)
                            done(multistatus);
                        else
                        {
                            if(e === Errors.BadAuthentication)
                                arg.setCode(HTTPCodes.Unauthorized);
                            else
                                arg.setCode(HTTPCodes.InternalServerError);
                            callback();
                        }
                    })
                    return;
                }
                
                arg.requirePrivilege('canGetChildren', resource, () => {
                    resource.getChildren((e, children) => process.nextTick(() => {

                        function err(e)
                        {
                            if(e === Errors.BadAuthentication)
                                arg.setCode(HTTPCodes.Unauthorized);
                            else
                                arg.setCode(HTTPCodes.InternalServerError);
                            callback();
                        }

                        addXMLInfo(resource, multistatus, (e) => {
                            if(e)
                            {
                                err(e);
                                return;
                            }

                            new Workflow()
                                .each(children, (r, cb) => addXMLInfo(r, multistatus, cb))
                                .error(err)
                                .done(() => {
                                    done(multistatus)
                                });
                        });
                    }))
                })
            }))
            
            function addXMLInfo(resource : IResource, multistatus, callback)
            {
                const reqBody = parseRequestBody(arg);

                const response = multistatus.ele('D:response')

                const propstat = response.ele('D:propstat')

                const privileges : BasicPrivilege[] = [
                    'canGetCreationDate', 'canGetAvailableLocks', 'canGetLastModifiedDate', 'canGetMimeType', 'canGetProperties', 'canGetSize', 'canGetType', 'canGetWebName'
                ];
                if(targetSource)
                    privileges.push('canSource');
                arg.requireErPrivilege(privileges, resource, (e, can) => {
                    if(e)
                    {
                        callback(e);
                        return;
                    }
                    
                    if(!can)
                    {
                        callback(Errors.BadAuthentication);
                        return;
                    }

                    propstat.ele('D:status').add('HTTP/1.1 200 OK')

                    const prop = propstat.ele('D:prop')
                    
                    let nb = 1;
                    function nbOut(error?)
                    {
                        if(nb > 0 && error)
                        {
                            nb = -1000;
                            callback(error);
                            return;
                        }

                        --nb;
                        if(nb === 0)
                        {
                            if(reqBody.leftElements.length > 0)
                            {
                                const propstatError = response.ele('D:propstat');
                                const prop = propstatError.ele('D:prop');
                                propstatError.ele('D:status').add(propstatStatus(HTTPCodes.NotFound));

                                for(let i = 0; i < reqBody.leftElements.length; ++i)
                                    if(reqBody.leftElements[i])
                                        prop.ele(reqBody.leftElements[i].name);
                            }
                            callback();
                        }
                    }
                    
                    const tags : any = {};

                    function mustDisplayTag(name : string)
                    {
                        if(reqBody.mustDisplay('DAV:' + name))
                            tags[name] = {
                                el: prop.ele('D:' + name),
                                value: reqBody.mustDisplayValue('DAV:' + name)
                            };
                        else
                            tags[name] = {
                                value: false
                            };
                    }

                    mustDisplayTag('getlastmodified')
                    mustDisplayTag('lockdiscovery')
                    mustDisplayTag('supportedlock')
                    mustDisplayTag('creationdate')
                    mustDisplayTag('resourcetype')
                    mustDisplayTag('displayname')
                    mustDisplayTag('getetag')

                    function displayValue(values : string[] | string, fn : () => void)
                    {
                        if(values.constructor === String ? tags[values as string].value : (values as string[]).some((n) => tags[n].value))
                        {
                            ++nb;
                            process.nextTick(fn);
                        }
                    }

                    displayValue('creationdate', () =>
                    {
                        resource.creationDate((e, ticks) => process.nextTick(() => {
                            if(!e)
                                tags.creationdate.el.add(arg.dateISO8601(ticks));
                            nbOut(e);
                        }))
                    })

                    ++nb;
                    arg.getResourcePath(resource, (e, path) => {
                        if(e)
                        {
                            nbOut(e);
                            return;
                        }
                            
                        if(tags.lockdiscovery.value)
                        {
                            ++nb;
                            lockDiscovery(lockDiscoveryCache, arg, new FSPath(path), resource, (e, l) => {
                                if(e)
                                {
                                    nbOut(e);
                                    return;
                                }

                                for(const path in l)
                                {
                                    for(const _lock of l[path])
                                    {
                                        const lock : Lock = _lock;
                                        const activelock = tags.lockdiscovery.el.ele('D:activelock');
                                        
                                        activelock.ele('D:lockscope').ele('D:' + lock.lockKind.scope.value.toLowerCase())
                                        activelock.ele('D:locktype').ele('D:' + lock.lockKind.type.value.toLowerCase())
                                        activelock.ele('D:depth').add('Infinity')
                                        if(lock.owner)
                                            activelock.ele('D:owner').add(lock.owner)
                                        activelock.ele('D:timeout').add('Second-' + (lock.expirationDate - Date.now()))
                                        activelock.ele('D:locktoken').ele('D:href', undefined, true).add(lock.uuid)
                                        activelock.ele('D:lockroot').ele('D:href', undefined, true).add(arg.fullUri(path).replace(' ', '%20'))
                                    }
                                }
                                
                                nbOut(null);
                            })
                        }
                        
                        resource.type((e, type) => process.nextTick(() => {
                            if(e)
                            {
                                nbOut(e);
                                return;
                            }
                            
                            const p = arg.fullUri(path).replace(' ', '%20');
                            response.ele('D:href', undefined, true).add(p.lastIndexOf('/') !== p.length - 1 && type.isDirectory ? p + '/' : p);
                            response.ele('D:location').ele('D:href', undefined, true).add(p);

                            if(tags.resourcetype.value && type.isDirectory)
                                tags.resourcetype.el.ele('D:collection')
                                
                            if(type.isFile)
                            {
                                mustDisplayTag('getcontentlength')
                                mustDisplayTag('getcontenttype')

                                if(tags.getcontenttype.value)
                                {
                                    ++nb;
                                    resource.mimeType(targetSource, (e, mimeType) => process.nextTick(() => {
                                        if(!e)
                                            tags.getcontenttype.el.add(mimeType)
                                        nbOut(e);
                                    }))
                                }

                                if(tags.getcontentlength.value)
                                {
                                    ++nb;
                                    resource.size(targetSource, (e, size) => process.nextTick(() => {
                                        if(!e)
                                            tags.getcontentlength.el.add(size === undefined || size === null || size.constructor !== Number ? 0 : size)
                                        nbOut(e);
                                    }))
                                }
                            }

                            nbOut();
                        }))
                    })

                    displayValue('displayname', () =>
                    {
                        let methodDisplayName = resource.webName;
                        if(resource.displayName)
                            methodDisplayName = resource.displayName;
                        
                        methodDisplayName.bind(resource)((e, name) => process.nextTick(() => {
                            if(!e)
                                tags.displayname.el.add(name ? name : '');
                            nbOut(e);
                        }))
                    })

                    displayValue('supportedlock', () =>
                    {
                        resource.getAvailableLocks((e, lockKinds) => process.nextTick(() => {
                            if(e)
                            {
                                nbOut(e);
                                return;
                            }

                            lockKinds.forEach((lockKind) => {
                                const lockentry = tags.supportedlock.el.ele('D:lockentry')

                                const lockscope = lockentry.ele('D:lockscope')
                                lockscope.ele('D:' + lockKind.scope.value.toLowerCase())

                                const locktype = lockentry.ele('D:locktype')
                                locktype.ele('D:' + lockKind.type.value.toLowerCase())
                            })
                            nbOut();
                        }))
                    })

                    displayValue([ 'getetag', 'getlastmodified' ], () =>
                    {
                        resource.lastModifiedDate((e, lastModifiedDate) => process.nextTick(() => {
                            if(!e)
                            {
                                if(tags.getetag.value)
                                    tags.getetag.el.add(ETag.createETag(lastModifiedDate))
                                if(tags.getlastmodified.value)
                                    tags.getlastmodified.el.add(new Date(lastModifiedDate).toUTCString())
                            }
                            nbOut(e);
                        }))
                    })

                    ++nb;
                    process.nextTick(() => {
                        resource.getProperties((e, properties) => process.nextTick(() => {
                            if(e)
                            {
                                nbOut(e);
                                return;
                            }

                            for(const name in properties)
                            {
                                if(reqBody.mustDisplay(name))
                                {
                                    const tag = prop.ele(name);
                                    if(reqBody.mustDisplayValue(name))
                                        tag.add(properties[name]);
                                }
                            }
                            nbOut();
                        }))
                    })

                    nbOut();
                })
            }

            function done(multistatus)
            {
                arg.setCode(HTTPCodes.MultiStatus);
                arg.writeXML(multistatus);
                callback();
            }
        })
    })
}

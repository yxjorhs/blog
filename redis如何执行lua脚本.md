# redis如何执行lua脚本

顺着路径

server.c->redisCommandTable->evalCommand->evalGenericCommand

找到evalGenericCommand，eval指令的对应函数，其入参如下

```c
void evalGenericCommand(client *c, int evalsha) {
```

c即为发送lua脚本的客户端

**evalsha是个整数类型，取值有0与1，它有什么作用?**

redis可以通过eval与evalSha执行lua脚本

区别在于eval输入整个脚本以及参数

evalsha只需要输入脚本的校验码以及参数，相对eval，可以节省带宽

因此evalsha起到一个告知函数是eval命令还是evalSha命令的作用



redis每次只能执行一次lua脚本，很多状态都保存在server实例中，执行脚本需要对这些状态进行初始化

```c
server.lua_random_dirty = 0;
server.lua_write_dirty = 0;
server.lua_replicate_commands = server.lua_always_replicate_commands;
server.lua_multi_emitted = 0;
server.lua_repl = PROPAGATE_AOF|PROPAGATE_REPL;
```



判断下命令的参数个数是否正确

```c
if (getLongLongFromObjectOrReply(c,c->argv[2],&numkeys,NULL) != C_OK)
    return;
if (numkeys > (c->argc - 3)) {
    addReplyError(c,"Number of keys can't be greater than number of args");
    return;
} else if (numkeys < 0) {
        addReplyError(c,"Number of keys can't be negative");
    return;
}
```



获取校验码，eval需要根据输入的指令计算，evalsha1直接从参数中获取

```c
if (!evalsha) {
    /* Hash the code if this is an EVAL call */
    sha1hex(funcname+2,c->argv[1]->ptr,sdslen(c->argv[1]->ptr));
} else {
    /* We already have the SHA if it is a EVALSHA */
    int j;
    char *sha = c->argv[1]->ptr;

    /* Convert to lowercase. We don't use tolower since the function
         * managed to always show up in the profiler output consuming
         * a non trivial amount of time. */
    for (j = 0; j < 40; j++)
        funcname[j+2] = (sha[j] >= 'A' && sha[j] <= 'Z') ?
        sha[j]+('a'-'A') : sha[j];
    funcname[42] = '\0';
}
```



根据校验码从全局查找脚本解析后的缓存，evalsha找不到缓存则返回，eval找不到缓存则解析脚本并创建缓存，因此不管是eval还是evalSha都有缓存脚本的功能

lua是一个指针，指向server.lua，全局的lua脚本解析器，所有lua指令共用，因此一次只能执行一个lua脚本

```c
lua_getglobal(lua, funcname);
if (lua_isnil(lua,-1)) {
    lua_pop(lua,1); /* remove the nil from the stack */
    /* Function not defined... let's define it if we have the
         * body of the function. If this is an EVALSHA call we can just
         * return an error. */
    if (evalsha) {
        lua_pop(lua,1); /* remove the error handler from the stack. */
        addReply(c, shared.noscripterr);
        return;
    }
    if (luaCreateFunction(c,lua,c->argv[1]) == NULL) {
        lua_pop(lua,1); /* remove the error handler from the stack. */
        /* The error is sent to the client by luaCreateFunction()
             * itself when it returns NULL. */
        return;
    }
    /* Now the following is guaranteed to return non nil */
    lua_getglobal(lua, funcname);
    serverAssert(!lua_isnil(lua,-1));
}
```

给lua解析器传入key和参数

```c
luaSetGlobalArray(lua,"KEYS",c->argv+3,numkeys);
luaSetGlobalArray(lua,"ARGV",c->argv+3+numkeys,c->argc-3-numkeys);
```

server.lua_client为虚拟的执行lua脚本client，设置其db为实际client的db

```c
selectDb(server.lua_client,c->db->id);
```

给lua脚本解析设置hook，超时则停止脚本解析，debug状态下则每解析一行则触发一次回调

```c
 /* Set a hook in order to be able to stop the script execution if it
     * is running for too much time.
     * We set the hook only if the time limit is enabled as the hook will
     * make the Lua script execution slower.
     *
     * If we are debugging, we set instead a "line" hook so that the
     * debugger is call-back at every line executed by the script. */
server.lua_caller = c;
server.lua_time_start = mstime();
server.lua_kill = 0;
if (server.lua_time_limit > 0 && ldb.active == 0) {
    lua_sethook(lua,luaMaskCountHook,LUA_MASKCOUNT,100000);
    delhook = 1;
} else if (ldb.active) {
    lua_sethook(server.lua,luaLdbLineHook,LUA_MASKLINE|LUA_MASKCOUNT,100000);
    delhook = 1;
}
```

执行脚本

```c
err = lua_pcall(lua,0,1,-2);
```



不管是否执行完毕，清空hook；超时则将client由保护态释放，在下一个安全时间尝试再次执行

```c
/* Perform some cleanup that we need to do both on error and success. */
if (delhook) lua_sethook(lua,NULL,0,0); /* Disable hook */
if (server.lua_timedout) {
    server.lua_timedout = 0;
    /* Restore the client that was protected when the script timeout
         * was detected. */
    unprotectClient(c);
    if (server.masterhost && server.master)
        queueClientForReprocessing(server.master);
}
server.lua_caller = NULL;
```



每执行50次lua脚本就会进行垃圾回收

```c
/* Call the Lua garbage collector from time to time to avoid a
     * full cycle performed by Lua, which adds too latency.
     *
     * The call is performed every LUA_GC_CYCLE_PERIOD executed commands
     * (and for LUA_GC_CYCLE_PERIOD collection steps) because calling it
     * for every command uses too much CPU. */
#define LUA_GC_CYCLE_PERIOD 50
{
    static long gc_count = 0;

    gc_count++;
    if (gc_count == LUA_GC_CYCLE_PERIOD) {
        lua_gc(lua,LUA_GCSTEP,LUA_GC_CYCLE_PERIOD);
        gc_count = 0;
    }
}
```



向客户端返回执行结果

```c
if (err) {
    addReplyErrorFormat(c,"Error running script (call to %s): %s\n",
                        funcname, lua_tostring(lua,-1));
    lua_pop(lua,2); /* Consume the Lua reply and remove error handler. */
} else {
    /* On success convert the Lua return value into Redis protocol, and
         * send it to * the client. */
    luaReplyToRedisReply(c,lua); /* Convert and consume the reply. */
    lua_pop(lua,1); /* Remove the error handler. */
}
```


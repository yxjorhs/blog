以前背八股文的时候，经常看到这么介绍redis

​	数据保存在内存，是个单线程，速度很快，性能甩mysql几条街

后来又看到说不是的，所以它到底是还是不是



# redis-server是怎么跑起来的

从server.c文件找到main函数

* **main(int argc, char \*\*argv)**

  ​	argv是个字符串数组，保存了启动指令携带的参数，例如输入:

  ```
  redis-server -v
  Redis server v=5.0.12 sha=265341b5:0 malloc=jemalloc-5.1.0 bits=64 build=c287ec797ecae670
  ```

  ​	那么argv便为["redis-server", "-v"]

  ​	argc为数组的长度

  * **spt_init** 

    spt初始化，执行后才能调用**setproctitle**来为进程命名

  * **initServerConfig** 

    对全局变量server进行初始化(基本所有数据都保存在server内，字段都有好几百个)

    例如:

    * 配置文件地址，是否开启aof等，初始化时大部分为null或者false，会在后面加载完配置文件后修改为配置值
    * 命令字典，get，set，hget等命令是以一个字典的形式保存在server.commands指针字段中，甚至对于del，expire这些使用频率高的命令，直接开个server.delCommand指针字段保存，节省去字典找的步骤

  * **模块系统初始化**

  * **处理非启动server的指令**

    假设指令是redis-server -v|--help这些的话，直接打印对应的数据，然后结束进程

  * **读取指令中的启动配置**

    例如: 配置文件地址、--port，--loglevel等

  * **loadServerConfig** 

    从配置文件加载配置

  * **是否以后台的方式启动**

    是则fork()出一个子进程，结束父进程，子进程被init进程领养，作为守护进程在后台运行

  * **initServer**

    * 创建空的客户端实例双向链表（连接到服务的客户端会以双向链表的形式保存，server.clients记录只想这个链表的地址，redis内大部分都是使用双向链表）

    * 创建空的monitors链表

    * 创建共享数据对象(1-10000，当我们保存值为这个范围内时，不会创建新的robj对象保存数据，直接使用这些共享数据，这些数据没有过期时间，且永远不会被lru策略淘汰)

    *  **aeCreateEventLoop()**

      ae是一个事件驱动的库，创建一个事件循环，将相关信息保存进server.el中，完成server初始化后，线程会进入这个事件循环中，用来接受、完成、返回客户端尽请求、以及处理定时任务(redisServer是事件驱动的)

    * 分配db空间(默认16个)

    * 监听端口、将socket设为非阻塞(多路复用进行网络io的前提条件)

    * 为16个db创建数据字典、过期时间字典等

    * 为发布订阅模式的渠道创建字典(channel => clients链表)

    * 为发布订阅模式的模糊匹配创建链表(链表结点保存匹配模式以及client)

    * 通过**aeCreateTimeEvent**注册定时任务**serverCron**的时间事件

      * **serverCron**
        * lua垃圾回收
        * **clientsCron** 客户端实例的定时任务
          * 超时处理
          * 请求内容缓冲队列的碎片回收
          * 跟踪使用了大量内存的客户端实例
        * **databasesCron** 数据库定时任务
          * **activeExpireCycle(ACTIVE_EXPIRE_CYCLE_SLOW)** 

            取出少量样本，淘汰过期的key

          * 检查各个db是否需要扩容缩容，需要的话则增量地进行

          * 计入近期aof重写失败、或aof文件过大、执行aof重写

          * 假如近期生成rdb失败、或产生大量修改，执行rdb

          * 将server.aof_buf写入server.aof_fd，根据策略判断是否执行fsync()

          * 关闭需要被关闭的客户端

    * 通过**aeCreateFileEvent**给socket(ip + 监听端口)注册文件事件

      使用epoll_ctl控制文件描述符号(socket也是文件描述符)，控制后可以在后面的循环中使用epoll_wait来获取客户端tcp连接请求(显然，对于网络io，redis使用了多路复用)

    * ...略

  * **redisSetProcTitle(argv[0]);**

    设置进程名为argv[0]，即redis-server

  * **checkTcpBacklogSettings();** 检查TCP队列长度

  * **moduleLoadFromQueue**

    模块加载

  * **InitServerLast**

    * **bioInit** 

      bio初始化，bio提供了一个线程，用于执行后台任务，例如: server.aof_buf同步到磁盘，write()写进文件描述符号后，fsync()操作是在后台任务执行的(server.aof_fsync默认everysec，每秒fsync一次)

    * 再更新下server完成初始化使用的内存

  * **loadDataFromDisk**

    从磁盘加载数据，根据配置决定是使用rdb加载还是aof加载

  * **aeSetBeforeSleepProc(server.el,beforeSleep)**

    这里是将一个beforeSleep函数的地址保存到server.el.beforeSleep中

  * **aeSetAfterSleepProc(server.el,afterSleep);**

    将afterSleep函数地址保存到server.el.afterSleep中

  * **aeMain**

    完成准备工作后，主线程进入无限循环

    ```c
    void aeMain(aeEventLoop *eventLoop) {
        eventLoop->stop = 0;
        while (!eventLoop->stop) {
            if (eventLoop->beforesleep != NULL)
                eventLoop->beforesleep(eventLoop);
            aeProcessEvents(eventLoop, AE_ALL_EVENTS|AE_CALL_AFTER_SLEEP);
        }
    }
    ```

    * beforesleep

      * **activeExpireCycle(ACTIVE_EXPIRE_CYCLE_FAST)** 

        取出少量样本，淘汰过期的key，与slow相比，fast多了一个执行时间不能超过1000微秒的限制

      * **processUnblockedClients**

        * 遍历非阻塞的client（在上一个循环的sleep过程中接收到完整的请求指令的客户端实例）

        * **processInputBufferAndReplicate**
          * **processInputBuffer**
            * **processCommand**
              * 判断指令，quit指令直接返回ok，其他指令从指令字典查找并检查参数数量是否正确

              * 客户端授权判断

              * 内存超过上限，且指令会增加使用没存时返回错误信息

              * 磁盘异常、只读从库等遇到写入指令时返回错误信息

              * 发布订阅模式的server只允许执行SUBSCRIBE， UNSUBSCRIBE

              * lua脚本执行速度慢时只允许少许执行

              * 事务内的指令则放入client内的指令队列中，返回，等待exec

              * **call** 

                * **replicationFeedMonitors** 

                  将执行的指令添加到server.monitors队列

                * 执行指令，结果放入client.buf中，定时返回给客户端

                * 执行时间过长则将其放入slowlog

                * 将指令写入aof_buf

      * **flushAppendOnlyFile**

        将server.aof_buf写入磁盘的文件描述符中

    * **aeProcessEvents**
      * 处理文件事件

        使用epoll_wait获取前面注册的文件描述符、socket的数据，为了不影响线程的运行，只监听很短的时间就结束，类似时分复用，会将获取到的数据保存到client实例中，在下一个循环的beforesleep进行处理

      * **aftersleep** 不用模块的话没啥逻辑

      * 处理时间事件，例如前面的定时任务



# 那么到底是不是单线程

从代码看，redis-server确实是只用了一个线程，以一种不断循环的方式，遍历所有发送请求的客户端，一个一个地处理请求

**单线程为什么比mysql快**

尽管只有一个线程处理请求，但大部分操作都是内存级的，所以它很快；尽管有磁盘io、网络io等操作，但都是将数据写入一个内存中的缓冲字段，定时处理；而mysql虽然也有缓冲池，但数据保存在磁盘，处理用户请求的时候，遇到没缓存的页，则不得不从磁盘获取，lru链表没空间的时候还得把脏页给刷回磁盘

**单线程的缺点**

因此是单线程，当某些指令需要耗费很多时间时，其他客户端的请求都会被阻塞到，例如使用keys的时候，字典保存了十几万个key，都遍历完要花个十几秒，一跑起来redis就不能处理其他命令，阻塞个十几秒，对其他client来说，它就是崩了

**那redis是单线程进程吗?**

redis确实只用了一个线程处理客户端请求，但它不是单线程进程

举个栗子

* bgsave 后台生成快照，它并不会跟keys一样，运行的时候导致redis不能工作，因为它fork了一个子进程出来进行快照生成
* unlink 后台删除key，把删除任务加入了bio线程，交给bio线程去运行

因此，redis-server是个多进程、多线程的


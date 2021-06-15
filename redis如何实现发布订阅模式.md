# redis如何实现发布订阅模式

## 发布订阅模式是什么

发布订阅模式类似一种广播，实现多个redis-client之间进行通讯

相关指令信息如下

```shell
127.0.0.1:6379> help subscribe

  SUBSCRIBE channel [channel ...]
  summary: Listen for messages published to the given channels
  since: 2.0.0
  group: pubsub
  
127.0.0.1:6379> help publish

  PUBLISH channel message
  summary: Post a message to a channel
  since: 2.0.0
  group: pubsub
127.0.0.1:6379> help psubscribe

  PSUBSCRIBE pattern [pattern ...]
  summary: Listen for messages published to channels matching the given patterns
  since: 2.0.0
  group: pubsub
```

假设client1执行了subscribe channel1指令，那么client1便会对channel1这个渠道进行监听

然后client2执行了publish channel1 msg，那么client1便可以接收到msg这个内容



psubscribe是一种泛渠道匹配功能，可以让客户端监听pattern所对应的channel，例如

psubscribe channel* 便可以监听channel1, channel2...等前缀为channel的渠道



## 怎么实现

先看看publish的指令入手，在server.c的redisCommandTable找到publish对应的指令publishCommand，其代码如下

```c
void publishCommand(client *c) {
    int receivers = pubsubPublishMessage(c->argv[1],c->argv[2]);
    if (server.cluster_enabled)
        clusterPropagatePublish(c->argv[1],c->argv[2]);
    else
        forceCommandPropagation(c,PROPAGATE_REPL);
    addReplyLongLong(c,receivers);
}
```

显然pubsubPublishMessage是pulish指令主要代码，后面是与cluster相关的操作

pubsubPublisMessage代码如下

```c
int pubsubPublishMessage(robj *channel, robj *message) {
    ...

    /* server.pubsub_channels是一个字典
     * channel作为key，订阅这个channel的客户端组成的链表作为这个字典的value
     */
        
    /* Send to clients listening for that channel */
    de = dictFind(server.pubsub_channels,channel); // 通过channel在字典中找到对应的客户端链表
    
    if (de) {
        ...

        listRewind(list,&li); // 创建一个链表遍历的迭代器
        while ((ln = listNext(&li)) != NULL) { // 遍历链表，给每个客户端发送消息
            ...
        }
    }
    
    /* server.pubsub_patterns是一个链表
     * 每个节点的值的结构如下
     * typedef struct pubsubPattern {
     *      client *client; // 订阅这个匹配模式的客户端
     *      robj *pattern; // 匹配模式
     *  } pubsubPattern;
     */
    
    /* Send to clients listening to matching channels */
    if (listLength(server.pubsub_patterns)) {
        listRewind(server.pubsub_patterns,&li);
        channel = getDecodedObject(channel);
        while ((ln = listNext(&li)) != NULL) {
            // 当节点的pattern包括channel时，为其client发送信息
            ....
        }
    }
}
```

从上面可以知道

输入publish指令时，使用channel字段在server.pubsub_channels字典中找到所有订阅该channel的client，对所有的client发送message，那么相应的，subscribe指令的执行就是往server.pubsub_channels这个字典添加client；

**但unsubscribe取消订阅指令在不输入channel时，是可以删除client所有订阅渠道的，这是不是要把字典遍历一边?**

不用，subscribe时除了在server.pubusb_channels注册了client之外，在这个client实例中也有一个pubsub_channels字段，记录了这个client所订阅的channel，只需要遍历client的pubsub_channels便可以取消client所有订阅



psubscribe、punsubscribe与上面基本类似，这是使用的是链表结构的pubsub_patterns字段，需要遍历处理


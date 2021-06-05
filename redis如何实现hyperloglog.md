# redis如何实现hyperloglog

## hyperloglog是什么

日常开发无法避免的会做PV、UV统计，PV的话直接使用incr对数据+1操作，UV则需要对数据做一个去重判断才能+1，可以使用字典、集合、mysql来实现，但存在一个问题，占空间，为了去重每个元素都要记录，一个元素4字节，1000个便是4k，100万个便是4M

精准的计算UV，无法避免地，我们还是需要占用这么多空间

但当这些UV统计并不需要100%精准时，redis提供了hyperloglo功能，至多使用12kB的空间作UV统计，数值上限为2^50，误差在0.8%左右

主要提供了以下几个函数

* pfadd 给hyperloglog添加元素
* pfcount 计算hyperloglog元素数量
* pfmerge 合并两个hyperloglog



## loglogCounting 对数计数算法

hyperloglog算法是基于loglogCounting算法，因此了解hyperloglog之前先了解loglogCounting是如何实现去重统计的

1. 初始化store=0,
2. 输入a，假设a经过散列之后的32位为:  ...01100100
3. 从地位向高位查找1，1在第三位上，取得 v = 3
4. 将v与store比较，是否大于store，是则store=v
5. 新的基数估算为 n = 2^store = 2 ^ 3 =8

**为什么可以这么估算**

a经过散列为32位的hash值后，每位上是取1还是0是随机的，都是二分之一的概率，从低往高找1的过程中，第一次找到的概率为1/2，第二次找到的概率为1/4，即

P(1) = 1/2

P(2) = 1/4

...

P(32) = 1/(2^32)

显然我们随便插入一个元素，大概率获得1,2,3，极小概率获得32，但随着元素插入数量变多，便有更高的几率获得更高的count值并更新到store

因此可以2^ store来估算基数

**这么估算会有什么问题**

元素数量越少，误差越大，万一第一个hash得到100...，那结果直接就变最大值了

**如何解决误差打的问题**

因此llc提出了**分组**来减小这个误差

1. 初始化m=3, store[3] = {0}

2. 将hash拆成两部分

3. 低m位作为组id，高的32-m位(v最大值由32变成了29)用来计算v

   例:

   ​	上面a得到的hash取低3位作为组id，则

   ​	id = 100(二进制) = 8

   ​	v从第四位往前找1，在第六位找到，则

   ​	v = 3

   ​	id = v - 1 = 2

4. 判断 count > store[id]，是则更新store[id]

5. 计算n

   n

   = 2 ^ (store[0] + store[1]  + .... + store[7]) / (2 ^ m)

   = (2 ^ 3) / (2 ^ 3)

   = 8  /  8

   = 1

显然m越大，分组2^m越多，误差越小，估值n便越准



## hyperloglog 超对数计数算

hyperloglog基于llc，区别在于n的计算方式

llc是以算数平均公式来计算n

n = 2 ^ (s(0) + ... + s(g)) / g 	// s(g) 代表 store[group]

hll是使用调和平均数(倒数平均数)来计算n，以获得更精准的计数值

n = 2 ^ (g / (1/s(0) + ... + 1/s(g)))



举例比较两种求n的差别

假设group为8，存储了4个值，对应的v分别为, 3, 2, 2, 4

llc:

​	n = 2 ^ (( 3 + 2 + 2 + 4) / 8) = 2 ^ (11 / 8)

hll:

​	n = 2 ^ (1 / (1/3 + 1/2 + 1/2 + 1/4)) = 2 ^ (19 / 12)

显然hll的n更接近4



## redis的hyperloglog算法的实现

**那么redis是如何使用12kb的空间来进行去重统计?且计数上限为什么是2^50?**

在redis中，对元素的hash使用了[MurMurHash64A](#MurMurHash64A)算法，将元素散列为64位的哈希值

在hll算法中m取14, 即低14位用于计算分组group, 高50位用于计算组的存储值v

因为使用了50位计算v，因此最大计数值为2^50

14位用于分组，则有2^14=16384个组, 每个组存储的v范围为0-50，因此每个v最多只需要6位来存储

16384 * 6 / 8 = 12KB，因此redis每个hyperloglog只需要12KB来计数

**0.8%的误差是怎么来的?**

以前面hyperloglog的求基数的算法，当插入一个元素的hash之后计算得到的v刚好为1时，基数算得的结果为2^50，显然远远超过0.8%这个误差上限

因此redis的hyperloglog是使用了新的求基数的算法

```c
double hllTau(double x) {
    if (x == 0. || x == 1.) return 0.;
    double zPrime;
    double y = 1.0;
    double z = 1 - x;
    do {
        x = sqrt(x);
        zPrime = z;
        y *= 0.5;
        z -= pow(1 - x, 2)*y;
    } while(zPrime != z);
    return z / 3;
}
double hllSigma(double x) {
    if (x == 1.) return INFINITY;
    double zPrime;
    double y = 1;
    double z = x;
    do {
        x *= x;
        zPrime = z;
        z += x * y;
        y += y;
    } while(zPrime != z);
    return z;
}
uint64_t hllCount(struct hllhdr *hdr, int *invalid) {
    double m = HLL_REGISTERS;
    double E;
    
    ...
     
    double z = m * hllTau((m-reghisto[HLL_Q+1])/(double)m);
    for (j = HLL_Q; j >= 1; --j) {
        z += reghisto[j];
        z *= 0.5;
    }
    z += m * hllSigma(reghisto[0]/(double)m);
    E = llroundl(HLL_ALPHA_INF*m*m/z);

    return (uint64_t) E;
}
```

论文<https://arxiv.org/pdf/1702.01284.pdf>

TODO

## hllhdr结构

```c#
struct hllhdr {
    char magic[4];      /* "HYLL" */
    uint8_t encoding;   /* HLL_DENSE or HLL_SPARSE. */
    uint8_t notused[3]; /* Reserved for future use, must be zero. */
    uint8_t card[8];    /* Cached cardinality, little endian. */
    uint8_t registers[]; /* Data bytes. */
};
```

* magic 固定值HYLL，用于区别普通string对象
* encoding 编码格式，HLL_DENSE(0)代表register使用密集编码的格式，HLL_SPARSE(1)代表register使用稀疏编码格式
* card 缓存最近的基数估值
* register 用于估算的数据，即前面提到的redis使用的12K，保存的16384个6bit的v，但因为使用了稀疏编码并不一定真的占用12k，12k只是一个最大值

### 密集编码 HLL_SPARSE

即register保存了16384个6bit的组，共12kb

从低位到高位，每6位代表一个组值

例:

​	....44444433 33332222 22111111

xxxxxx代表一个值，因为以6位表示，存在跨字节的情况

redis使用HLL_DENSE_GET_REGISTER函数获取register中指定位置的值，HLL_DENSE_SET_REGISTER修改register中指定位置的值

```c
#define HLL_DENSE_GET_REGISTER(target,p,regnum) do { \
    uint8_t *_p = (uint8_t*) p; \
    unsigned long _byte = regnum*HLL_BITS/8; \
    unsigned long _fb = regnum*HLL_BITS&7; \
    unsigned long _fb8 = 8 - _fb; \
    unsigned long b0 = _p[_byte]; \
    unsigned long b1 = _p[_byte+1]; \
    target = ((b0 >> _fb) | (b1 << _fb8)) & HLL_REGISTER_MAX; \
} while(0)
#define HLL_DENSE_SET_REGISTER(p,regnum,val) do { \
    uint8_t *_p = (uint8_t*) p; \
    unsigned long _byte = regnum*HLL_BITS/8; \
    unsigned long _fb = regnum*HLL_BITS&7; \
    unsigned long _fb8 = 8 - _fb; \
    unsigned long _v = val; \
    _p[_byte] &= ~(HLL_REGISTER_MAX << _fb); \
    _p[_byte] |= _v << _fb; \
    _p[_byte+1] &= ~(HLL_REGISTER_MAX >> _fb8); \
    _p[_byte+1] |= _v >> _fb8; \
} while(0)

```



### 稀疏编码 HLL_DENSE

当我hyperloglog仅保存几个元素时，便立即为其分配12kb的空间显然太浪费了

因此为了节省空间，使用了稀疏编码，对于重复的组直接使用计数，例：

register为 00000....000000(16384位)

稀疏编码直接保存为 01111111 11111111 表示16384位上都是0

稀疏编码分3种

* ZERO `00xxxxxx  ` 占1字节，表示1-64个连续的组值为0
* XZERO `01xxxxxx` 占2字节，表示1-16384个连续的组值为0
* VAL `1vvxxxxx` 占1字节，表示1-4个连续的组的值为1-32，因此当稀疏编码存在值超过32时便会发生编码转换

hyperloglog创建时使用稀疏编码，当某个组的值超过32位，或稀疏编码长度超过指定阈值(HLL_SPARSE_MAX_BYTES, 默认3k)时，便会转为密集编码



### 内部编码 HLL_RAW

当使用pfcount多个key的时候，会执行hllmerge合并操作，生成一个临时的hll对象，这个临时对象合并了多个key的register，只用于本次计算，不作保存，因此不需要过于节省空间，便在密集编码的基础上使用了8bit来保存组值，每个字节保存一个值，不存在跨字节的问题，提升计算速度



## pfadd的实现

根据key找到hllhdr或者新建一个

根据hllhdr的encoding确定是密集编码还是稀疏编码

将元素使用[MurmurHash64A](#MurmurHash64A)散列得到一个64位的hash值

hash值的低14位作为组，即register的下标index

高50位按从低到高查找1，计算count值

将count保存到register[index]

## pfcount的实现

遍历pfcount的key

使用hllMerge将多个key的register合并为一个

使用hllcount从合并后register中获得各个组的值

根据组值估算基数



## MurmurHash64A

MurmurHash2算法的64位版本，将字符串散列为64位，代码如下

```c
uint64_t MurmurHash64A (const void * key, int len, unsigned int seed) {
    const uint64_t m = 0xc6a4a7935bd1e995;
    const int r = 47;
    uint64_t h = seed ^ (len * m);
    const uint8_t *data = (const uint8_t *)key;
    const uint8_t *end = data + (len-(len&7));

    while(data != end) {
        uint64_t k;

#if (BYTE_ORDER == LITTLE_ENDIAN)
    #ifdef USE_ALIGNED_ACCESS
        memcpy(&k,data,sizeof(uint64_t));
    #else
        k = *((uint64_t*)data);
    #endif
#else
        k = (uint64_t) data[0];
        k |= (uint64_t) data[1] << 8;
        k |= (uint64_t) data[2] << 16;
        k |= (uint64_t) data[3] << 24;
        k |= (uint64_t) data[4] << 32;
        k |= (uint64_t) data[5] << 40;
        k |= (uint64_t) data[6] << 48;
        k |= (uint64_t) data[7] << 56;
#endif

        k *= m;
        k ^= k >> r;
        k *= m;
        h ^= k;
        h *= m;
        data += 8;
    }

    switch(len & 7) {
    case 7: h ^= (uint64_t)data[6] << 48; /* fall-thru */
    case 6: h ^= (uint64_t)data[5] << 40; /* fall-thru */
    case 5: h ^= (uint64_t)data[4] << 32; /* fall-thru */
    case 4: h ^= (uint64_t)data[3] << 24; /* fall-thru */
    case 3: h ^= (uint64_t)data[2] << 16; /* fall-thru */
    case 2: h ^= (uint64_t)data[1] << 8; /* fall-thru */
    case 1: h ^= (uint64_t)data[0];
            h *= m; /* fall-thru */
    };

    h ^= h >> r;
    h *= m;
    h ^= h >> r;
    return h;
}
```


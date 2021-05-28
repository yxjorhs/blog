# redis是如何实现geo功能的



## geo是什么

地理位置功能，主要包括

* 坐标存储
* 计算坐标间的距离
* 查找坐标范围内的其他坐标



## 坐标是如何存储的

我们可以通过指令

geoadd key longtitude latitude member

来添加坐标点



**但这个坐标点是怎么存储在数据库的？直接保存经度、纬度?**

其实是通过geohash算法将经纬度转为一个hash值



geoadd的逻辑如下

1. server端用uint32类型接受经度、纬度
2. 将经纬度由[-180,+180], [[-85, +85]](#为什么纬度的范围是+-85)的区间映射到[[0, 2^26]](#为什么要将经纬度映射到[0, 2^26]这个区间)区间得到26位有效数字的偏移值
3. 将两个偏移值进行[二进制交叉运算](#二进制交叉运算)得到52位有效数字的geohash值

4. 使用[zset](#为什么使用zset存储)存储坐标，key为指令输入的key，member为指令输入的member，score为geohash



### 为什么纬度的范围是+-85

我们在redis输出指令

```
geoadd k 0 86 a
```

会报错(error) ERR invalid longitude,latitude pair 0.000000,86.000000

但输入

```	
geoadd k 0 84 a
```

就成功了, 显然redis有一个纬度85度的限制



我们想下，地球是圆形的，点(0, 0),点(180, 0)的纬度都是0，他们的距离差不多是半圈地球，但(0, 90)和(180,90)他们的距离是多少，0，因为他们压根是同一个点



然而redis的坐标体系是平面的，(0,90)到(180,90)的距离与(0, 0) 到(180, 0)的距离一样，即平面坐标体系存在纬度越高，与实际差距越大的问题



因此redis直接抛弃85度以上的点



### 为什么要将经纬度映射到[0, 2^26]这个区间

redis定义了经纬度的最大精度为26位，对应的geohash为52位

```c
#define GEO_STEP_MAX 26 /* 26*2 = 52 bits. */
```



这是因为经纬度精确到26位的时候，在地图上的定位已经可以精确到米以下了

```
(12742 * 1000) * Math.PI / Math.pow(2,26)
0.5964960693127087
```



在geohashEncode中，经纬度会被转为小数后会乘以2^26，即将其经纬度映射到[0, 2^26]这个区间，再将映射后的结果转为geohash

```c
double lat_offset =
        (latitude - lat_range->min) / (lat_range->max - lat_range->min);
double long_offset =
        (longitude - long_range->min) / (long_range->max - long_range->min);

/* convert to fixed point based on the step size */
lat_offset *= (1ULL << step);
long_offset *= (1ULL << step);

hash->bits = interleave64(lat_offset, long_offset);
```



### 二进制交叉运算

一种将两个数值合并为一个的方法

例:

​	lon_offset =  ...00(26位)

​	lat_offset = ...11(26位)

​	geohash = ...1010(52位)

​			= 10

假设以经度作为x轴，维度作为y轴，他们做成的点从小到大链接起来的曲线为[z阶曲线](#z阶曲线)



### 为什么使用zset存储

redis的数据结构中仅zset的元素是按大小排序的，提供了zrangebyscore的功能，可以查找指定score范围内的元素

geo的查找指定坐标，指定范围内的坐标，即是利用zrangebyscore查找指定范围内的geohash来实现的



## 如何计算两个坐标之间的距离

使用geodist可以计算两个坐标之间的距离

geodist逻辑如下

1. 使用zset的dict找出两个点的经纬度
2. 使用[haversin](#haversin)算法计算球面上两个坐标的距离

### harversin

代码如下

```c
double geohashGetDistance(double lon1d, double lat1d, double lon2d, double lat2d) {
    double lat1r, lon1r, lat2r, lon2r, u, v;
    lat1r = deg_rad(lat1d); // deg_rad将经纬度转为对应的角度
    lon1r = deg_rad(lon1d);
    lat2r = deg_rad(lat2d);
    lon2r = deg_rad(lon2d);
    u = sin((lat2r - lat1r) / 2);
    v = sin((lon2r - lon1r) / 2);
    return 2.0 * EARTH_RADIUS_IN_METERS *
           asin(sqrt(u * u + cos(lat1r) * cos(lat2r) * v * v));
}
```



## georadius的实现

我们可以指定坐标、半径，使用georadius查找指定范围内的坐标数量，或是使用georadiusbymembers列出这些坐标

georadius跟georaduisbymembers都是依赖georadiusGeneric函数来实现，逻辑如下:

1. 根据查找半径计算大于这个半径的最小geohash精度，目的是在覆盖查找范围的前提下，尽量缩小查找范围

2. 目标坐标转为geohash

3. 以步骤1查找的精度为单位，查找目标geohash的邻居，即周围的8个点，参考[z阶曲线](#z阶曲线)

4. 目标点以及8个邻居点共9个geohash，看起来只有9个点，但将精度精确到52位时，每个点都代表了一个区域

   例:

   ​	二进制11只占2位，但它变为52位时它可代表范围为

   ​	[110 0 × 49, 111 0 × 49)

   ​	共 2^50个点

5. 从zset找出在这9个geohash范围内的坐标

   1. 使用zrangebyscore找出geohash对应的区间范围内的score
   2. score值即坐标的geohash，转为坐标
   3. 使用haversin计算坐标与目标点的距离
   4. 返回距离小于半径的坐标

6. 返回筛选数量或点的坐标



## z阶曲线



![](https://tse1-mm.cn.bing.net/th/id/OIP.DWvU-mQHxI1YemBKZFJ0KwHaHS?pid=ImgDet&rs=1)

